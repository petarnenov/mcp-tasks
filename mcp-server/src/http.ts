/**
 * The HTTP face: an MCP endpoint and a health probe, on a plain `node:http` server.
 *
 * No web framework. The SDK ships adapters for Express, Fastify and Hono, but this service has
 * exactly two routes and a framework here would be a dependency whose only job is `if (path ===
 * ...)`.
 *
 * Kept separate from `index.ts` so the tests can start a real server on an ephemeral port and
 * drive it with a real MCP client, rather than importing a module that binds a fixed port as a
 * side effect of being loaded.
 */

import { createServer, type Server } from 'node:http';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { createServerFactory } from './server.js';
import { TasksClient } from './tasks-client.js';

export const MCP_PATH = '/mcp';
export const SERVICE_NAME = 'tasks-mcp';

export interface McpHttpServer {
    readonly server: Server;
    /** Stops listening and tears down in-flight MCP exchanges. */
    close(): Promise<void>;
}

export function createMcpHttpServer(options: {
    tasksApiUrl: string;
    onerror?: (error: Error) => void;
}): McpHttpServer {
    const report = options.onerror ?? ((error: Error) => console.error('[mcp]', error));
    const tasks = new TasksClient(options.tasksApiUrl);

    // `legacy: 'stateless'` is the default, stated explicitly because it is a decision rather
    // than an accident: modern (2026-07-28) clients get the sessionless envelope protocol, and
    // 2025-era clients are still served, each request answered by a fresh instance. Setting this
    // to 'reject' would drop every client that has not moved to the 2026 revision yet.
    const handler = createMcpHandler(createServerFactory(tasks), {
        legacy: 'stateless',
        onerror: report,
    });

    const mcp = toNodeHandler(handler, { onerror: report });

    const server = createServer((request, response) => {
        const host = request.headers.host ?? 'localhost';
        const path = new URL(request.url ?? '/', `http://${host}`).pathname;

        // Probed by the compose healthcheck. Deliberately does NOT call the task API: this
        // answers "is this process up", the api's own /health answers "is the api up".
        // Conflating them makes an api restart look like an MCP failure and pulls healthy
        // replicas out of the load balancer for a fault they cannot fix.
        if (path === '/health') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ status: 'UP', service: SERVICE_NAME }));
            return;
        }

        if (path === MCP_PATH) {
            // No Host or Origin guard. The SDK ships localhostHostValidation() and
            // localhostOriginValidation() for servers bound to loopback on a developer's
            // machine; here nginx rewrites Host and both guards would reject every proxied
            // request. This endpoint inherits the task API's security posture, which is none --
            // see the spec's non-goals.
            void mcp(request, response);
            return;
        }

        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: `No route for ${path}. The MCP endpoint is ${MCP_PATH}.` }));
    });

    return {
        server,
        async close() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await handler.close();
        },
    };
}
