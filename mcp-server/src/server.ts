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

import { registerTaskPrompts } from './prompts.js';
import { registerTaskResources } from './resources.js';
import type { TasksClient } from './tasks-client.js';
import { registerTaskTools } from './tools.js';

export const SERVER_INFO = {
    name: 'tasks',
    version: '0.1.0',
} as const;

export function createServerFactory(tasks: TasksClient): McpServerFactory {
    return () => {
        // `listChanged: false` on both, declared rather than left to the SDK.
        //
        // Registering a resource or a prompt makes the SDK declare that capability for you, and
        // it defaults listChanged to TRUE for both. This server can never send either
        // notification: the factory above is called once per request and the instance is
        // discarded, so there is no connection to notify on -- and nothing to notify about, since
        // writes go through the api, which does not call us, and the prompt text is compiled in.
        // Advertising it makes a client open a subscriptions/listen stream and wait for refreshes
        // that cannot arrive; our own browser client would do exactly that.
        //
        // `resources.subscribe` is left undeclared for the same structural reason. `completions`
        // is declared by the SDK itself as soon as a completable argument exists, and both the
        // resource template and plan_task have one.
        const server = new McpServer(SERVER_INFO, {
            capabilities: {
                resources: { listChanged: false },
                prompts: { listChanged: false },
            },
        });
        registerTaskTools(server, tasks);
        registerTaskResources(server, tasks);
        registerTaskPrompts(server, tasks);
        return server;
    };
}
