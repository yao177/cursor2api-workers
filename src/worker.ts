import 'dotenv/config';
import type { RequestHandler } from 'express';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from './app.js';
import { getConfig } from './config.js';

type BindingValue = string | number | boolean | undefined | null;

let workerHandler: ReturnType<typeof httpServerHandler> | null = null;

function applyEnv(env: Record<string, BindingValue>): void {
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || value === null) continue;
        process.env[key] = String(value);
    }
    process.env.LOG_FILE_ENABLED = process.env.LOG_FILE_ENABLED || 'false';
}

function ensureWorkerHandler(env: Record<string, BindingValue>) {
    if (workerHandler) return workerHandler;

    applyEnv(env);

    const config = getConfig();
    const app = createApp({ enableLogViewer: false });
    const notSupported: RequestHandler = (_req, res) => {
        res.status(501).json({
            error: {
                message: 'Cloudflare Workers 部署暂不支持内置日志查看器',
                type: 'not_supported',
            },
        });
    };
    app.get('/logs', notSupported);
    app.get('/api/logs', notSupported);
    app.get('/api/requests', notSupported);
    app.get('/api/stats', notSupported);
    app.get('/api/payload/:requestId', notSupported);
    app.get('/api/logs/stream', notSupported);
    app.post('/api/logs/clear', notSupported);
    app.listen(config.port);

    workerHandler = httpServerHandler({ port: config.port });
    return workerHandler;
}

export default {
    fetch(request: Request, env: Record<string, BindingValue>, ctx: ExecutionContext) {
        return ensureWorkerHandler(env).fetch(request, env, ctx);
    },
};
