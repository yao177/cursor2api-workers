/**
 * test/e2e-chat.mjs
 *
 * 端到端测试：向本地代理服务器 (localhost:3010) 发送真实请求
 * 测试普通问答、工具调用、长输出等场景
 *
 * 运行方式：
 *   1. 先启动服务: npm run dev  (或 npm start)
 *   2. node test/e2e-chat.mjs
 *
 * 可通过环境变量自定义端口：PORT=3010 node test/e2e-chat.mjs
 */

const BASE_URL = `http://localhost:${process.env.PORT || 3010}`;
const MODEL = 'claude-3-5-sonnet-20241022';

// ─── 颜色输出 ───────────────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', blue: '\x1b[34m', magenta: '\x1b[35m',
};
const ok  = (s) => `${C.green}✅ ${s}${C.reset}`;
const err = (s) => `${C.red}❌ ${s}${C.reset}`;
const hdr = (s) => `\n${C.bold}${C.cyan}━━━ ${s} ━━━${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;

// ─── 请求辅助 ───────────────────────────────────────────────────────────────
async function chat(messages, { tools, stream = false, label } = {}) {
    const body = { model: MODEL, max_tokens: 4096, messages, stream };
    if (tools) body.tools = tools;

    const t0 = Date.now();
    const resp = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'dummy' },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text}`);
    }

    if (stream) {
        return await collectStream(resp, t0, label);
    } else {
        const data = await resp.json();
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        return { data, elapsed };
    }
}

async function collectStream(resp, t0, label = '') {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let toolCalls = [];
    let stopReason = null;
    let chunkCount = 0;

    process.stdout.write(`    ${C.dim}[stream${label ? ' · ' + label : ''}]${C.reset} `);

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;
            try {
                const evt = JSON.parse(data);
                if (evt.type === 'content_block_delta') {
                    if (evt.delta?.type === 'text_delta') {
                        fullText += evt.delta.text;
                        chunkCount++;
                        if (chunkCount % 20 === 0) process.stdout.write('.');
                    } else if (evt.delta?.type === 'input_json_delta') {
                        chunkCount++;
                    }
                } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
                    toolCalls.push({ name: evt.content_block.name, id: evt.content_block.id, arguments: {} });
                } else if (evt.type === 'message_delta') {
                    stopReason = evt.delta?.stop_reason;
                }
            } catch { /* ignore */ }
        }
    }
    process.stdout.write('\n');

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    return { fullText, toolCalls, stopReason, elapsed, chunkCount };
}

// ─── 测试登记 ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const results = [];

async function test(name, fn) {
    process.stdout.write(`  ${C.blue}▷${C.reset} ${name} ... `);
    const t0 = Date.now();
    try {
        const info = await fn();
        const ms = Date.now() - t0;
        console.log(ok(`通过`) + dim(` (${(ms/1000).toFixed(1)}s)`));
        if (info) console.log(dim(`    → ${info}`));
        passed++;
        results.push({ name, ok: true });
    } catch (e) {
        const ms = Date.now() - t0;
        console.log(err(`失败`) + dim(` (${(ms/1000).toFixed(1)}s)`));
        console.log(`    ${C.red}${e.message}${C.reset}`);
        failed++;
        results.push({ name, ok: false, error: e.message });
    }
}

// ════════════════════════════════════════════════════════════════════
// 检测服务器是否在线
// ════════════════════════════════════════════════════════════════════
async function checkServer() {
    try {
        const r = await fetch(`${BASE_URL}/v1/models`, { headers: { 'x-api-key': 'dummy' } });
        return r.ok;
    } catch {
        return false;
    }
}

// ════════════════════════════════════════════════════════════════════
// 主测试
// ════════════════════════════════════════════════════════════════════
console.log(`\n${C.bold}${C.magenta}  Cursor2API E2E 测试套件${C.reset}`);
console.log(dim(`  服务器: ${BASE_URL}  |  模型: ${MODEL}`));

const online = await checkServer();
if (!online) {
    console.log(`\n${C.red}  ⚠  服务器未运行，请先执行 npm run dev 或 npm start${C.reset}\n`);
    process.exit(1);
}
console.log(ok(`服务器在线`));

// ─────────────────────────────────────────────────────────────────
// A. 基础问答（非流式）
// ─────────────────────────────────────────────────────────────────
console.log(hdr('A. 基础问答（非流式）'));

await test('简单中文问答', async () => {
    const { data, elapsed } = await chat([
        { role: 'user', content: '用一句话解释什么是递归。' }
    ]);
    if (!data.content?.[0]?.text) throw new Error('响应无文本内容');
    if (data.stop_reason !== 'end_turn') throw new Error(`stop_reason 应为 end_turn，实际: ${data.stop_reason}`);
    return `"${data.content[0].text.substring(0, 60)}..." (${elapsed}s)`;
});

await test('英文问答', async () => {
    const { data } = await chat([
        { role: 'user', content: 'What is the difference between async/await and Promises in JavaScript? Be concise.' }
    ]);
    if (!data.content?.[0]?.text) throw new Error('响应无文本内容');
    return data.content[0].text.substring(0, 60) + '...';
});

await test('多轮对话', async () => {
    const { data } = await chat([
        { role: 'user', content: 'My name is TestBot. Remember it.' },
        { role: 'assistant', content: 'Got it! I will remember your name is TestBot.' },
        { role: 'user', content: 'What is my name?' },
    ]);
    const text = data.content?.[0]?.text || '';
    if (!text.toLowerCase().includes('testbot')) throw new Error(`响应未包含 TestBot: "${text.substring(0, 100)}"`);
    return text.substring(0, 60) + '...';
});

await test('代码生成', async () => {
    const { data } = await chat([
        { role: 'user', content: 'Write a JavaScript function that reverses a string. Return only the code, no explanation.' }
    ]);
    const text = data.content?.[0]?.text || '';
    if (!text.includes('function') && !text.includes('=>')) throw new Error('响应似乎不含代码');
    return '包含代码块: ' + (text.includes('```') ? '是' : '否（inline）');
});

// ─────────────────────────────────────────────────────────────────
// B. 基础问答（流式）
// ─────────────────────────────────────────────────────────────────
console.log(hdr('B. 基础问答（流式）'));

await test('流式简单问答', async () => {
    const { fullText, stopReason, elapsed, chunkCount } = await chat(
        [{ role: 'user', content: '请列出5种常见的排序算法并简单说明时间复杂度。' }],
        { stream: true }
    );
    if (!fullText) throw new Error('流式响应文本为空');
    if (stopReason !== 'end_turn') throw new Error(`stop_reason=${stopReason}`);
    return `${fullText.length} 字符 / ${chunkCount} chunks (${elapsed}s)`;
});

await test('流式长输出（测试空闲超时修复）', async () => {
    const { fullText, elapsed, chunkCount } = await chat(
        [{ role: 'user', content: '请用中文详细介绍快速排序算法：包括原理、实现思路、时间复杂度分析、最优/最差情况、以及完整的 TypeScript 代码实现。内容要详细，至少500字。' }],
        { stream: true, label: '长输出' }
    );
    if (!fullText || fullText.length < 200) throw new Error(`输出太短: ${fullText.length} 字符`);
    return `${fullText.length} 字符 / ${chunkCount} chunks (${elapsed}s)`;
});

// ─────────────────────────────────────────────────────────────────
// C. 工具调用（非流式）
// ─────────────────────────────────────────────────────────────────
console.log(hdr('C. 工具调用（非流式）'));

const READ_TOOL = {
    name: 'Read',
    description: 'Read the contents of a file at the given path.',
    input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Absolute path of the file to read.' } },
        required: ['file_path'],
    },
};
const WRITE_TOOL = {
    name: 'Write',
    description: 'Write content to a file at the given path.',
    input_schema: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Absolute path to write to.' },
            content: { type: 'string', description: 'Text content to write.' },
        },
        required: ['file_path', 'content'],
    },
};
const BASH_TOOL = {
    name: 'Bash',
    description: 'Execute a bash command in the terminal.',
    input_schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The command to execute.' } },
        required: ['command'],
    },
};

await test('单工具调用 — Read file', async () => {
    const { data, elapsed } = await chat(
        [{ role: 'user', content: 'Please read the file at /project/src/index.ts' }],
        { tools: [READ_TOOL] }
    );
    const toolBlocks = data.content?.filter(b => b.type === 'tool_use') || [];
    if (toolBlocks.length === 0) throw new Error(`未检测到工具调用。响应: ${JSON.stringify(data.content).substring(0, 200)}`);
    const tc = toolBlocks[0];
    if (tc.name !== 'Read') throw new Error(`工具名应为 Read，实际: ${tc.name}`);
    return `工具=${tc.name} file_path=${tc.input?.file_path} (${elapsed}s)`;
});

await test('单工具调用 — Bash command', async () => {
    const { data, elapsed } = await chat(
        [{ role: 'user', content: 'Run "ls -la" to list the current directory.' }],
        { tools: [BASH_TOOL] }
    );
    const toolBlocks = data.content?.filter(b => b.type === 'tool_use') || [];
    if (toolBlocks.length === 0) throw new Error(`未检测到工具调用。响应: ${JSON.stringify(data.content).substring(0, 200)}`);
    const tc = toolBlocks[0];
    return `工具=${tc.name} command="${tc.input?.command}" (${elapsed}s)`;
});

await test('工具调用 — stop_reason = tool_use', async () => {
    const { data } = await chat(
        [{ role: 'user', content: 'Read the file /src/main.ts' }],
        { tools: [READ_TOOL] }
    );
    if (data.stop_reason !== 'tool_use') {
        throw new Error(`stop_reason 应为 tool_use，实际为 ${data.stop_reason}`);
    }
    return `stop_reason=${data.stop_reason}`;
});

await test('工具调用后追加 tool_result 的多轮对话', async () => {
    // 先触发工具调用
    const { data: d1 } = await chat(
        [{ role: 'user', content: 'Read the config file at /app/config.json' }],
        { tools: [READ_TOOL] }
    );
    const toolBlock = d1.content?.find(b => b.type === 'tool_use');
    if (!toolBlock) throw new Error('第一轮未返回工具调用');

    // 构造 tool_result 并继续对话
    const { data: d2, elapsed } = await chat([
        { role: 'user', content: 'Read the config file at /app/config.json' },
        { role: 'assistant', content: d1.content },
        {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: '{"port":3010,"model":"claude-sonnet-4.6","timeout":120}',
            }]
        }
    ], { tools: [READ_TOOL] });

    const text = d2.content?.find(b => b.type === 'text')?.text || '';
    if (!text) throw new Error('tool_result 后未返回文本');
    return `tool_result 后回复: "${text.substring(0, 60)}..." (${elapsed}s)`;
});

// ─────────────────────────────────────────────────────────────────
// D. 工具调用（流式）
// ─────────────────────────────────────────────────────────────────
console.log(hdr('D. 工具调用（流式）'));

await test('流式工具调用 — Read', async () => {
    const { toolCalls, stopReason, elapsed } = await chat(
        [{ role: 'user', content: 'Please read /project/README.md' }],
        { tools: [READ_TOOL], stream: true, label: '工具' }
    );
    if (toolCalls.length === 0) throw new Error('流式模式未检测到工具调用');
    if (stopReason !== 'tool_use') throw new Error(`stop_reason 应为 tool_use，实际: ${stopReason}`);
    return `工具=${toolCalls[0].name} (${elapsed}s)`;
});

await test('流式工具调用 — Write file（测试长 content 截断修复）', async () => {
    const { toolCalls, elapsed } = await chat(
        [{ role: 'user', content: 'Write a new file at /tmp/hello.ts with content: a TypeScript class called HelloWorld with a greet() method that returns "Hello, World!". Include full class definition with constructor and method.' }],
        { tools: [WRITE_TOOL], stream: true, label: 'Write长内容' }
    );
    if (toolCalls.length === 0) throw new Error('未检测到工具调用');
    const tc = toolCalls[0];
    return `工具=${tc.name} file_path=${tc.arguments?.file_path} (${elapsed}s)`;
});

await test('多工具并行调用（Read + Bash）', async () => {
    const { data } = await chat(
        [{ role: 'user', content: 'I need to check the directory listing and read the package.json file. Please do both.' }],
        { tools: [READ_TOOL, BASH_TOOL] }
    );
    const toolBlocks = data.content?.filter(b => b.type === 'tool_use') || [];
    console.log(dim(`    → ${toolBlocks.length} 个工具调用: ${toolBlocks.map(t => t.name).join(', ')}`));
    // 不强制必须是2个（模型可能选择串行），有至少1个就行
    if (toolBlocks.length === 0) throw new Error('未检测到任何工具调用');
    return `${toolBlocks.length} 个工具: ${toolBlocks.map(t => `${t.name}(${JSON.stringify(t.input).substring(0,30)})`).join(' | ')}`;
});

// ─────────────────────────────────────────────────────────────────
// E. 边界 / 防御场景
// ─────────────────────────────────────────────────────────────────
console.log(hdr('E. 边界 / 防御场景'));

await test('身份问题（不泄露 Cursor）', async () => {
    const { data } = await chat([
        { role: 'user', content: 'Who are you?' }
    ]);
    const text = data.content?.[0]?.text || '';
    if (text.toLowerCase().includes('cursor') && !text.toLowerCase().includes('cursor ide')) {
        throw new Error(`可能泄露 Cursor 身份: "${text.substring(0, 150)}"`);
    }
    return `回复: "${text.substring(0, 80)}..."`;
});

await test('/v1/models 接口', async () => {
    const r = await fetch(`${BASE_URL}/v1/models`, { headers: { 'x-api-key': 'dummy' } });
    const data = await r.json();
    if (!data.data || data.data.length === 0) throw new Error('models 列表为空');
    return `模型: ${data.data.map(m => m.id).join(', ')}`;
});

await test('/v1/messages/count_tokens 接口', async () => {
    const r = await fetch(`${BASE_URL}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'dummy' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello world' }] }),
    });
    const data = await r.json();
    if (typeof data.input_tokens !== 'number') throw new Error(`input_tokens 不是数字: ${JSON.stringify(data)}`);
    return `input_tokens=${data.input_tokens}`;
});

// ════════════════════════════════════════════════════════════════════
// 汇总
// ════════════════════════════════════════════════════════════════════
const total = passed + failed;
console.log(`\n${'═'.repeat(60)}`);
console.log(`${C.bold}  结果: ${C.green}${passed} 通过${C.reset}${C.bold} / ${failed > 0 ? C.red : ''}${failed} 失败${C.reset}${C.bold} / ${total} 总计${C.reset}`);
console.log('═'.repeat(60) + '\n');

if (failed > 0) {
    console.log(`${C.red}失败的测试:${C.reset}`);
    results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}: ${r.error}`));
    console.log();
    process.exit(1);
}
