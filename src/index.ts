/**
 * Cursor2API v2 - Node.js 入口
 */

import 'dotenv/config';
import type { Request, Response } from 'express';
import { getConfig } from './config.js';
import { loadLogsFromFiles } from './logger.js';
import { createApp } from './app.js';
import { VERSION } from './version.js';
import {
    serveLogViewer,
    apiGetLogs,
    apiGetRequests,
    apiGetStats,
    apiGetPayload,
    apiLogsStream,
    serveLogViewerLogin,
    apiClearLogs,
    servePublicFile,
} from './log-viewer.js';

const config = getConfig();
const app = createApp({ enableLogViewer: true });

const logViewerAuth = (req: Request, res: Response, next: (err?: unknown) => void) => {
    const tokens = config.authTokens;
    if (!tokens || tokens.length === 0) return next();

    const tokenFromQuery = req.query.token as string | undefined;
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
    const tokenFromHeader = authHeader ? String(authHeader).replace(/^Bearer\s+/i, '').trim() : undefined;
    const token = tokenFromQuery || tokenFromHeader;

    if (!token || !tokens.includes(token)) {
        if (req.path === '/logs') {
            return serveLogViewerLogin(req, res);
        }
        res.status(401).json({
            error: {
                message: 'Unauthorized. Provide token via ?token=xxx or Authorization header.',
                type: 'auth_error',
            },
        });
        return;
    }
    next();
};

app.get(/^\/public\/(.+)$/, servePublicFile);
app.get('/logs', logViewerAuth, serveLogViewer);
app.get('/api/logs', logViewerAuth, apiGetLogs);
app.get('/api/requests', logViewerAuth, apiGetRequests);
app.get('/api/stats', logViewerAuth, apiGetStats);
app.get('/api/payload/:requestId', logViewerAuth, apiGetPayload);
app.get('/api/logs/stream', logViewerAuth, apiLogsStream);
app.post('/api/logs/clear', logViewerAuth, apiClearLogs);

loadLogsFromFiles();

app.listen(config.port, () => {
    const auth = config.authTokens?.length ? `${config.authTokens.length} token(s)` : 'open';
    const logPersist = config.logging?.file_enabled ? `file → ${config.logging.dir}` : 'memory only';
    
    // Tools 配置摘要
    const toolsCfg = config.tools;
    let toolsInfo = 'default (compact, desc≤50)';
    if (toolsCfg) {
        const parts: string[] = [];
        parts.push(`schema=${toolsCfg.schemaMode}`);
        parts.push(toolsCfg.descriptionMaxLength === 0 ? 'desc=full' : `desc≤${toolsCfg.descriptionMaxLength}`);
        if (toolsCfg.includeOnly?.length) parts.push(`whitelist=${toolsCfg.includeOnly.length}`);
        if (toolsCfg.exclude?.length) parts.push(`blacklist=${toolsCfg.exclude.length}`);
        toolsInfo = parts.join(', ');
    }
    
    console.log('');
    console.log(`  \x1b[36m⚡ cursor2api-workers v${VERSION}\x1b[0m`);
    console.log(`  ├─ Server:  \x1b[32mhttp://localhost:${config.port}\x1b[0m`);
    console.log(`  ├─ Model:   ${config.cursorModel}`);
    console.log(`  ├─ Auth:    ${auth}`);
    console.log(`  ├─ Tools:   ${toolsInfo}`);
    console.log(`  ├─ Logging: ${logPersist}`);
    console.log(`  └─ Logs:    \x1b[35mhttp://localhost:${config.port}/logs\x1b[0m`);
    console.log('');
});
