import express from 'express';
import { getConfig } from './config.js';
import { handleMessages, listModels, countTokens } from './handler.js';
import { handleOpenAIChatCompletions, handleOpenAIResponses } from './openai-handler.js';
import { VERSION } from './version.js';

export interface CreateAppOptions {
    enableLogViewer: boolean;
}

export function createApp(options: CreateAppOptions) {
    const app = express();
    const config = getConfig();

    app.use(express.json({ limit: '50mb' }));

    app.use((_req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', '*');
        if (_req.method === 'OPTIONS') {
            res.sendStatus(200);
            return;
        }
        next();
    });

    app.use((req, res, next) => {
        if (req.method === 'GET' || req.path === '/health') {
            return next();
        }
        const tokens = config.authTokens;
        if (!tokens || tokens.length === 0) {
            return next();
        }
        const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
        if (!authHeader) {
            res.status(401).json({
                error: {
                    message: 'Missing authentication token. Use Authorization: Bearer <token>',
                    type: 'auth_error',
                },
            });
            return;
        }
        const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
        if (!tokens.includes(token)) {
            console.log(`[Auth] 拒绝无效 token: ${token.substring(0, 8)}...`);
            res.status(403).json({ error: { message: 'Invalid authentication token', type: 'auth_error' } });
            return;
        }
        next();
    });

    app.post('/v1/messages', handleMessages);
    app.post('/messages', handleMessages);

    app.post('/v1/chat/completions', handleOpenAIChatCompletions);
    app.post('/chat/completions', handleOpenAIChatCompletions);

    app.post('/v1/responses', handleOpenAIResponses);
    app.post('/responses', handleOpenAIResponses);

    app.post('/v1/messages/count_tokens', countTokens);
    app.post('/messages/count_tokens', countTokens);

    app.get('/v1/models', listModels);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', version: VERSION });
    });

    app.get('/', (_req, res) => {
        res.json({
            name: 'cursor2api-workers',
            version: VERSION,
            description: 'Cursor Docs AI → Anthropic & OpenAI & Cursor IDE API Proxy',
            endpoints: {
                anthropic_messages: 'POST /v1/messages',
                openai_chat: 'POST /v1/chat/completions',
                openai_responses: 'POST /v1/responses',
                models: 'GET /v1/models',
                health: 'GET /health',
                ...(options.enableLogViewer ? { log_viewer: 'GET /logs' } : {}),
            },
            usage: {
                claude_code: 'export ANTHROPIC_BASE_URL=http://localhost:' + config.port,
                openai_compatible: 'OPENAI_BASE_URL=http://localhost:' + config.port + '/v1',
                cursor_ide: 'OPENAI_BASE_URL=http://localhost:' + config.port + '/v1 (选用 Claude 模型)',
            },
        });
    });

    return app;
}
