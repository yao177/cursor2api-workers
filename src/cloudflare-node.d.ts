interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
}

declare module 'cloudflare:node' {
    export interface CloudflareNodeHandler {
        fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> | Response;
    }

    export function httpServerHandler(options: { port: number }): CloudflareNodeHandler;
}
