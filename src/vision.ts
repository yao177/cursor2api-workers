import { getConfig } from './config.js';
import type { AnthropicMessage, AnthropicContentBlock } from './types.js';
import { getVisionProxyFetchOptions } from './proxy-agent.js';

export async function applyVisionInterceptor(messages: AnthropicMessage[]): Promise<void> {
    const config = getConfig();
    if (!config.vision?.enabled) return;

    for (const msg of messages) {
        if (msg.role !== 'user') continue;
        if (!Array.isArray(msg.content)) continue;

        let hasImages = false;
        const newContent: AnthropicContentBlock[] = [];
        const imagesToAnalyze: AnthropicContentBlock[] = [];

        for (const block of msg.content) {
            if (block.type === 'image') {
                hasImages = true;
                imagesToAnalyze.push(block);
            } else {
                newContent.push(block);
            }
        }

        if (hasImages && imagesToAnalyze.length > 0) {
            try {
                let descriptions = '';
                if (config.vision.mode === 'ocr') {
                    descriptions = await processWithLocalOCR(imagesToAnalyze);
                } else {
                    descriptions = await callVisionAPI(imagesToAnalyze);
                }

                // Add descriptions as a simulated system text block
                newContent.push({
                    type: 'text',
                    text: `\n\n[System: The user attached ${imagesToAnalyze.length} image(s). Visual analysis/OCR extracted the following context:\n${descriptions}]\n\n`
                });

                msg.content = newContent;
            } catch (e) {
                console.error("[Vision API Error]", e);
                newContent.push({
                    type: 'text',
                    text: `\n\n[System: The user attached image(s), but the Vision interceptor failed to process them. Error: ${(e as Error).message}]\n\n`
                });
                msg.content = newContent;
            }
        }
    }
}

async function processWithLocalOCR(imageBlocks: AnthropicContentBlock[]): Promise<string> {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng+chi_sim');
    let combinedText = '';

    for (let i = 0; i < imageBlocks.length; i++) {
        const img = imageBlocks[i];
        let imageSource: string | Buffer = '';

        if (img.type === 'image' && img.source) {
            const sourceData = img.source.data || img.source.url;
            if (img.source.type === 'base64' && sourceData) {
                const mime = img.source.media_type || 'image/jpeg';
                imageSource = `data:${mime};base64,${sourceData}`;
            } else if (img.source.type === 'url' && sourceData) {
                imageSource = sourceData;
            }
        }

        if (imageSource) {
            try {
                const { data: { text } } = await worker.recognize(imageSource);
                combinedText += `--- Image ${i + 1} OCR Text ---\n${text.trim() || '(No text detected in this image)'}\n\n`;
            } catch (err) {
                console.error(`[Vision OCR] Failed to parse image ${i + 1}:`, err);
                combinedText += `--- Image ${i + 1} ---\n(Failed to parse image with local OCR)\n\n`;
            }
        }
    }

    await worker.terminate();
    return combinedText;
}

async function callVisionAPI(imageBlocks: AnthropicContentBlock[]): Promise<string> {
    const config = getConfig().vision!;

    // Construct an array of OpenAI format message parts
    const parts: any[] = [
        { type: 'text', text: 'Please describe the attached images in detail. If they contain code, UI elements, or error messages, explicitly write them out.' }
    ];

    for (const img of imageBlocks) {
        if (img.type === 'image' && img.source) {
            const sourceData = img.source.data || img.source.url;
            let url = '';
            // If it's a raw base64 string
            if (img.source.type === 'base64' && sourceData) {
                const mime = img.source.media_type || 'image/jpeg';
                url = `data:${mime};base64,${sourceData}`;
            } else if (img.source.type === 'url' && sourceData) {
                // Handle remote URLs natively mapped from OpenAI/Anthropic payloads
                url = sourceData;
            }
            if (url) {
                parts.push({ type: 'image_url', image_url: { url } });
            }
        }
    }

    const payload = {
        model: config.model,
        messages: [{ role: 'user', content: parts }],
        max_tokens: 1500
    };

    const res = await fetch(config.baseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(payload),
        ...getVisionProxyFetchOptions(),
    } as any);

    if (!res.ok) {
        throw new Error(`Vision API returned status ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content || 'No description returned.';
}
