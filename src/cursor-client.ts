/**
 * cursor-client.ts - Cursor API 客户端
 *
 * 职责：
 * 1. 向 Cursor /api/chat 发送请求（模拟 Chrome 浏览器 headers）
 * 2. 流式解析 SSE 响应
 * 3. 自动重试机制
 */

import type { CursorChatRequest, CursorSSEEvent } from './types.js'
import { getConfig } from './config.js'
import { getProxyFetchOptions } from './proxy-agent.js'

const CURSOR_CHAT_API = 'https://cursor.com/api/chat'
const MAX_RETRIES = 2
const RETRY_DELAY = 2000

// ==================== Headers ====================

function getChromeHeaders(): Record<string, string> {
  const { fingerprint } = getConfig()

  return {
    'Content-Type': 'application/json',
    'sec-ch-ua-platform': '"Windows"',
    'x-path': '/api/chat',
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'x-method': 'POST',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-arch': '"x86"',
    'sec-ch-ua-platform-version': '"19.0.0"',
    origin: 'https://cursor.com',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    referer: 'https://cursor.com/',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    priority: 'u=1, i',
    'user-agent': fingerprint.userAgent,
    'x-is-human': '',
    'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15'
  }
}

// ==================== Retry Wrapper ====================

async function withRetry(fn: () => Promise<void>) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await fn()
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[Cursor] 请求失败 (${attempt}/${MAX_RETRIES}): ${msg}`)

      if (attempt === MAX_RETRIES) throw err

      console.log(`[Cursor] ${RETRY_DELAY / 1000}s 后重试...`)
      await new Promise(r => setTimeout(r, RETRY_DELAY))
    }
  }
}

// ==================== SSE Parser ====================

function parseSSE(buffer: string, onChunk: (e: CursorSSEEvent) => void) {
  const lines = buffer.split('\n')
  const remainder = lines.pop() || ''

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue

    const payload = line.slice(6).trim()
    if (!payload) continue

    try {
      const event: CursorSSEEvent = JSON.parse(payload)
      onChunk(event)
    } catch {
      // ignore non-JSON payload
    }
  }

  return remainder
}

// ==================== API Request ====================

export async function sendCursorRequest(
  req: CursorChatRequest,
  onChunk: (event: CursorSSEEvent) => void
): Promise<void> {

  await withRetry(async () => {
    await sendCursorRequestInner(req, onChunk)
  })

}

// ==================== Core Request Logic ====================

async function sendCursorRequestInner(
  req: CursorChatRequest,
  onChunk: (event: CursorSSEEvent) => void
): Promise<void> {

  const config = getConfig()
  const controller = new AbortController()

  console.log(`[Cursor] 请求: model=${req.model}, messages=${req.messages.length}`)

  const IDLE_TIMEOUT_MS = config.timeout * 1000
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)

    idleTimer = setTimeout(() => {
      console.warn(`[Cursor] 空闲超时 (${config.timeout}s)，终止请求`)
      controller.abort()
    }, IDLE_TIMEOUT_MS)
  }

  resetIdleTimer()

  try {

    const resp = await fetch(CURSOR_CHAT_API, {
      method: 'POST',
      headers: getChromeHeaders(),
      body: JSON.stringify(req),
      signal: controller.signal,
      ...getProxyFetchOptions(),
    } as RequestInit)

    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`Cursor API HTTP ${resp.status}: ${body}`)
    }

    if (!resp.body) {
      throw new Error('Cursor API 响应无 body')
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()

    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      resetIdleTimer()

      buffer += decoder.decode(value, { stream: true })
      buffer = parseSSE(buffer, onChunk)
    }

    // flush remaining buffer
    if (buffer.startsWith('data: ')) {
      try {
        const event: CursorSSEEvent = JSON.parse(buffer.slice(6).trim())
        onChunk(event)
      } catch {}
    }

  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }

}

// ==================== Non-Streaming Helper ====================

export async function sendCursorRequestFull(
  req: CursorChatRequest
): Promise<string> {

  const chunks: string[] = []

  await sendCursorRequest(req, (event) => {
    if (event.type === 'text-delta' && event.delta) {
      chunks.push(event.delta)
    }
  })

  return chunks.join('')
}
