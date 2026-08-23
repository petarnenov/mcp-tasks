/**
 * Process entry point. Reads the environment, binds the port, and shuts down cleanly.
 *
 * Everything else is in `http.ts` — see the note there on why the two are split.
 */

import { createMcpHttpServer, MCP_PATH, SERVICE_NAME } from './http.js';

/** Overridden by TASKS_API_URL in compose; the default is the local-run address. */
const TASKS_API_URL = process.env['TASKS_API_URL'] ?? 'http://localhost:8080';
const PORT = Number(process.env['PORT'] ?? 8877);
/** 0.0.0.0, not loopback: the process runs in a container and nginx reaches it over the network. */
const HOST = process.env['HOST'] ?? '0.0.0.0';

const app = createMcpHttpServer({ tasksApiUrl: TASKS_API_URL });

app.server.listen(PORT, HOST, () => {
    console.log(`[mcp] ${SERVICE_NAME} listening on http://${HOST}:${PORT}${MCP_PATH}`);
    console.log(`[mcp] task api at ${TASKS_API_URL}`);
});

// Compose sends SIGTERM on `make down` and on every scale-down. Without this the process is
// killed after the grace period and in-flight tool calls die with it.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        console.log(`[mcp] ${signal} received, shutting down`);
        void app.close().then(() => process.exit(0));
    });
}
