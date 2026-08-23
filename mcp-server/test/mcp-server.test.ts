/**
 * The MCP server's correctness obligations, driven by a real MCP client over real HTTP.
 *
 * Each test's name starts with the number of the obligation it proves in
 * `vault/specs/mcp-server-typescript.md`. That mapping is the point: a failing test names the
 * obligation that broke.
 *
 * Nothing is mocked. A stub task API stands in for the real one — see `stub-tasks-api.ts` for why
 * it is a real HTTP server — and the client is the SDK's own `Client`, so these tests clear the
 * "a real MCP client connects" obligation that the Java implementation could never clear from
 * curl alone.
 */

import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { createMcpHttpServer, type McpHttpServer } from '../src/http.js';
import { startStubTasksApi, type StubTasksApi } from './stub-tasks-api.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-11-25';

let api: StubTasksApi;
let mcp: McpHttpServer;
let mcpUrl: URL;
const openClients: Client[] = [];

beforeAll(async () => {
    api = await startStubTasksApi();
    // Errors are expected in this suite (the 404 and 400 paths), so swallow them rather than
    // filling the test output with stack traces that are the point of the test.
    mcp = createMcpHttpServer({ tasksApiUrl: api.url, onerror: () => {} });
    await new Promise<void>((resolve) => mcp.server.listen(0, '127.0.0.1', resolve));
    mcpUrl = new URL(`${addressOf(mcp.server)}/mcp`);
});

afterAll(async () => {
    await mcp.close();
    await api.close();
});

afterEach(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    api.store.length = 0;
    api.requests.length = 0;
});

/** Connects a client pinned to the modern era — no probe, no legacy fallback. */
async function connectModern(): Promise<Client> {
    const client = new Client(
        { name: 'mcp-server-test', version: '0.1.0' },
        { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
    );
    openClients.push(client);
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    return client;
}

/** Connects a 2025-era client: the SDK's default negotiation mode is the legacy handshake. */
async function connectLegacy(): Promise<Client> {
    const client = new Client({ name: 'mcp-server-test-legacy', version: '0.1.0' });
    openClients.push(client);
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    return client;
}

function addressOf(server: Server): string {
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('server did not bind a TCP port');
    }
    return `http://127.0.0.1:${address.port}`;
}

/** Tools return text content; every assertion below reads it through here. */
function textOf(result: { content?: unknown }): string {
    const content = result.content as { type: string; text?: string }[] | undefined;
    return (content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
}

async function createTask(
    client: Client,
    args: Record<string, unknown>,
): Promise<{ id: string; [key: string]: unknown }> {
    const result = await client.callTool({ name: 'tasks_create', arguments: args });
    expect(result.isError ?? false, textOf(result)).toBe(false);
    return JSON.parse(textOf(result)) as { id: string };
}

describe('protocol', () => {
    it('1: a modern (2026-07-28) client connects and the server names itself tasks', async () => {
        const client = await connectModern();

        expect(client.getServerVersion()).toMatchObject({ name: 'tasks', version: '0.1.0' });
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);
        expect(client.getProtocolEra()).toBe('modern');
    });

    it('2: tools/list returns exactly the five tools, each described and schema-d', async () => {
        const client = await connectModern();

        const { tools } = await client.listTools();

        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'tasks_create',
            'tasks_delete',
            'tasks_get',
            'tasks_list',
            'tasks_update',
        ]);
        for (const tool of tools) {
            expect(tool.description, `${tool.name} has no description`).toBeTruthy();
            expect(tool.inputSchema, `${tool.name} has no inputSchema`).toMatchObject({ type: 'object' });
        }
    });

    it('3: a 2025-era client is still served, on the legacy revision', async () => {
        const client = await connectLegacy();

        expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY_PROTOCOL_VERSION);
        expect(client.getProtocolEra()).toBe('legacy');
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(5);
    });

    it('4: tools round-trip — create is visible through list and get', async () => {
        const client = await connectModern();

        const created = await createTask(client, { title: 'write the spec', priority: 'HIGH' });

        const listed = JSON.parse(textOf(await client.callTool({ name: 'tasks_list', arguments: {} })));
        expect(listed).toHaveLength(1);

        const fetched = JSON.parse(
            textOf(await client.callTool({ name: 'tasks_get', arguments: { id: created.id } })),
        );
        expect(fetched).toMatchObject({ id: created.id, title: 'write the spec', priority: 'HIGH' });
    });

    it('5: every request is self-contained — a second client sees the first one\'s writes', async () => {
        const first = await connectModern();
        const created = await createTask(first, { title: 'survives a new connection' });

        const second = await connectModern();
        const fetched = JSON.parse(
            textOf(await second.callTool({ name: 'tasks_get', arguments: { id: created.id } })),
        );

        expect(fetched).toMatchObject({ id: created.id });
    });
});

describe('semantics preserved through the wrapper', () => {
    it('6: tasks_update resets every omitted field', async () => {
        const client = await connectModern();
        const created = await createTask(client, {
            title: 'original',
            description: 'a description',
            status: 'IN_PROGRESS',
            priority: 'HIGH',
        });

        const updated = JSON.parse(
            textOf(
                await client.callTool({
                    name: 'tasks_update',
                    arguments: { id: created.id, title: 'renamed' },
                }),
            ),
        );

        expect(updated).toMatchObject({
            title: 'renamed',
            description: null,
            status: 'TODO',
            priority: 'MEDIUM',
        });
    });

    it('6b: the tasks_update description warns that omission resets', async () => {
        const client = await connectModern();

        const { tools } = await client.listTools();
        const update = tools.find((tool) => tool.name === 'tasks_update');

        // A model has no other way to learn this, so the warning is part of the contract.
        expect(update?.description).toMatch(/NOT a patch/);
    });

    it('7: tasks_delete is idempotent, on a real id and on one that never existed', async () => {
        const client = await connectModern();
        const created = await createTask(client, { title: 'delete me' });

        const first = await client.callTool({ name: 'tasks_delete', arguments: { id: created.id } });
        const second = await client.callTool({ name: 'tasks_delete', arguments: { id: created.id } });
        const never = await client.callTool({
            name: 'tasks_delete',
            arguments: { id: '00000000-0000-0000-0000-000000000000' },
        });

        expect(first.isError ?? false).toBe(false);
        expect(second.isError ?? false).toBe(false);
        expect(never.isError ?? false).toBe(false);
    });

    it('8: an unknown id is a readable tool error, not a protocol error', async () => {
        const client = await connectModern();

        // A rejected promise here would mean the failure arrived as JSON-RPC -32603, which is
        // the bug this asserts against: the model would get an opaque code instead of a message.
        const result = await client.callTool({
            name: 'tasks_get',
            arguments: { id: '00000000-0000-0000-0000-000000000000' },
        });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/No task with id/);
        expect(textOf(result)).toMatch(/tasks_list/);
    });

    it('9: a validation failure from the api arrives as a readable tool error', async () => {
        const client = await connectModern();

        const result = await client.callTool({ name: 'tasks_create', arguments: { title: '   ' } });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/title is non-blank/);
    });

    it('10: an unreachable task API is reported as such, not as a hang or a stack trace', async () => {
        // A port nothing is listening on: connection refused, the shape of "the api is down".
        const offline = createMcpHttpServer({ tasksApiUrl: 'http://127.0.0.1:1', onerror: () => {} });
        await new Promise<void>((resolve) => offline.server.listen(0, '127.0.0.1', resolve));
        const client = new Client({ name: 'offline-test', version: '0.1.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${addressOf(offline.server)}/mcp`)));

        const result = await client.callTool({ name: 'tasks_list', arguments: {} });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/Could not reach the task API/);
        await client.close();
        await offline.close();
    });
});

describe('http surface', () => {
    it('11: /health answers without touching the task API', async () => {
        const before = api.requests.length;

        const response = await fetch(`${addressOf(mcp.server)}/health`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: 'UP', service: 'tasks-mcp' });
        // The probe must not depend on the api: a healthy replica behind a restarting api would
        // otherwise be pulled out of the load balancer for a fault it cannot fix.
        expect(api.requests.length).toBe(before);
    });

    it('12: an unknown path is a clean 404 naming the MCP endpoint', async () => {
        const response = await fetch(`${addressOf(mcp.server)}/tasks`);

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: expect.stringContaining('/mcp') });
    });
});
