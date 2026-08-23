/**
 * Assembly: what an MCP server instance for this service contains.
 *
 * Exported as a *factory* rather than a singleton because `createMcpHandler` builds one instance
 * per request. That is not a performance compromise, it is the property the deployment depends
 * on: no instance outlives the request that created it, so no replica accumulates state and any
 * replica can answer any request. See vault/specs/mcp-server-typescript.md, "Why this one can
 * scale".
 */

import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';

import type { TasksClient } from './tasks-client.js';
import { registerTaskTools } from './tools.js';

export const SERVER_INFO = {
    name: 'tasks',
    version: '0.1.0',
} as const;

export function createServerFactory(tasks: TasksClient): McpServerFactory {
    return () => {
        const server = new McpServer(SERVER_INFO);
        registerTaskTools(server, tasks);
        return server;
    };
}
