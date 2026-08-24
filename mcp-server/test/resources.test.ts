/**
 * The resource obligations from `vault/specs/mcp-resources.md`, driven by a real MCP client.
 *
 * A file of its own rather than more tests in `mcp-server.test.ts`: the numbers in that file belong
 * to [[mcp-server-typescript]], and two specs numbering into one file is how a failing test stops
 * naming the obligation that broke. Same stub api, same "nothing is mocked" rule.
 */

import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Client, ResourceNotFoundError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { createMcpHttpServer, type McpHttpServer } from '../src/http.js';
import { TASK_URI_TEMPLATE, TASKS_URI } from '../src/resources.js';
import { startStubTasksApi, type StubTasksApi } from './stub-tasks-api.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

let api: StubTasksApi;
let mcp: McpHttpServer;
let mcpUrl: URL;
const openClients: Client[] = [];

beforeAll(async () => {
    api = await startStubTasksApi();
    // The not-found and unreachable paths are the point of half this suite, so their stack traces
    // are noise rather than signal.
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

async function connectModern(): Promise<Client> {
    const client = new Client(
        { name: 'mcp-resources-test', version: '0.1.0' },
        { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
    );
    openClients.push(client);
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    return client;
}

/** A 2025-era client: the SDK's default negotiation is the legacy handshake. */
async function connectLegacy(): Promise<Client> {
    const client = new Client({ name: 'mcp-resources-test-legacy', version: '0.1.0' });
    openClients.push(client);
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    return client;
}

/** A server pointed at a port nothing listens on: the shape of "the api is down". */
async function connectToOfflineApi(): Promise<{ client: Client; close: () => Promise<void> }> {
    const offline = createMcpHttpServer({ tasksApiUrl: 'http://127.0.0.1:1', onerror: () => {} });
    await new Promise<void>((resolve) => offline.server.listen(0, '127.0.0.1', resolve));
    const client = new Client({ name: 'offline-resources-test', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${addressOf(offline.server)}/mcp`)));
    return {
        client,
        close: async () => {
            await client.close();
            await offline.close();
        },
    };
}

function addressOf(server: Server): string {
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('server did not bind a TCP port');
    }
    return `http://127.0.0.1:${address.port}`;
}

/** The text of a single-content resource read. */
function textOf(result: { contents: { text?: string }[] }): string {
    return result.contents.map((content) => content.text ?? '').join('\n');
}

function toolTextOf(result: { content?: unknown }): string {
    const content = result.content as { type: string; text?: string }[] | undefined;
    return (content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
}

async function createTask(client: Client, args: Record<string, unknown>): Promise<{ id: string }> {
    const result = await client.callTool({ name: 'tasks_create', arguments: args });
    expect(result.isError ?? false, toolTextOf(result)).toBe(false);
    return JSON.parse(toolTextOf(result)) as { id: string };
}

/** Reads a resource, bypassing the client's cache so a test never asserts against a held entry. */
function read(client: Client, uri: string): Promise<{ contents: { text?: string }[] }> {
    return client.readResource({ uri }, { cacheMode: 'bypass' });
}

describe('the resource surface', () => {
    it('1: resources/list returns exactly the collection, described and typed', async () => {
        const client = await connectModern();

        const { resources } = await client.listResources(undefined, { cacheMode: 'bypass' });

        expect(resources).toHaveLength(1);
        expect(resources[0]).toMatchObject({
            uri: TASKS_URI,
            name: 'tasks',
            mimeType: 'application/json',
        });
        expect(resources[0]?.description).toBeTruthy();
    });

    it('2: resources/list does not call the task API, and answers while the api is down', async () => {
        const client = await connectModern();
        await createTask(client, { title: 'listed but not fetched' });
        const before = api.requests.length;

        const { resources } = await client.listResources(undefined, { cacheMode: 'bypass' });

        // The template's `list` callback is undefined precisely so this holds: an api outage must
        // not take out the listing of the one resource still worth having in that state.
        expect(resources).toHaveLength(1);
        expect(api.requests.length).toBe(before);

        const offline = await connectToOfflineApi();
        const offlineList = await offline.client.listResources(undefined, { cacheMode: 'bypass' });
        expect(offlineList.resources).toHaveLength(1);
        await offline.close();
    });

    it('3: resources/templates/list returns exactly the task template', async () => {
        const client = await connectModern();

        const { resourceTemplates } = await client.listResourceTemplates(undefined, { cacheMode: 'bypass' });

        expect(resourceTemplates).toHaveLength(1);
        expect(resourceTemplates[0]).toMatchObject({
            uriTemplate: TASK_URI_TEMPLATE,
            name: 'task',
            mimeType: 'application/json',
        });
    });
});

describe('reading', () => {
    it('4: the collection returns every task, identical to what tasks_list returns', async () => {
        const client = await connectModern();
        await createTask(client, { title: 'first' });
        await createTask(client, { title: 'second', priority: 'HIGH' });

        const result = await read(client, TASKS_URI);
        const listed = await client.callTool({ name: 'tasks_list', arguments: {} });

        expect(result.contents).toHaveLength(1);
        expect(result.contents[0]).toMatchObject({ uri: TASKS_URI, mimeType: 'application/json' });
        // Byte-identical, not merely equivalent: a difference in this text should never be a
        // formatting difference a reader has to rule out first.
        expect(textOf(result)).toBe(toolTextOf(listed));
        expect(JSON.parse(textOf(result))).toHaveLength(2);
    });

    it('5: a task by id returns that task, identical to what tasks_get returns', async () => {
        const client = await connectModern();
        const created = await createTask(client, { title: 'readable', description: 'by uri' });
        const uri = `${TASKS_URI}/${created.id}`;

        const result = await read(client, uri);
        const fetched = await client.callTool({ name: 'tasks_get', arguments: { id: created.id } });

        expect(result.contents[0]).toMatchObject({ uri, mimeType: 'application/json' });
        expect(textOf(result)).toBe(toolTextOf(fetched));
        expect(JSON.parse(textOf(result))).toMatchObject({ id: created.id, title: 'readable' });
    });

    it('6: an unknown id is a resource-not-found error, not a 200 with an error body', async () => {
        const client = await connectModern();

        const failure = await read(client, `${TASKS_URI}/00000000-0000-0000-0000-000000000000`)
            .then(() => undefined, (error: unknown) => error);

        // -32602 with data {uri}, on both eras. The SDK never emits -32002; recognising the error
        // is what tells a client "there is no such thing" apart from "the request was malformed".
        expect(ResourceNotFoundError.isInstance(failure)).toBe(true);
        expect(failure).toMatchObject({
            code: -32602,
            data: { uri: `${TASKS_URI}/00000000-0000-0000-0000-000000000000` },
        });
    });

    it('7: a URI matching no resource and no template is the same error', async () => {
        const client = await connectModern();

        const failure = await read(client, 'tasks://nothing/here')
            .then(() => undefined, (error: unknown) => error);

        expect(ResourceNotFoundError.isInstance(failure)).toBe(true);
        expect(failure).toMatchObject({ code: -32602, data: { uri: 'tasks://nothing/here' } });
    });

    it('8: an unreachable task API is a readable message, distinct from not-found', async () => {
        const offline = await connectToOfflineApi();

        const failure = await offline.client
            .readResource({ uri: TASKS_URI }, { cacheMode: 'bypass' })
            .then(() => undefined, (error: unknown) => error);

        // A ProtocolError carries its message to the wire; a bare Error would arrive as an opaque
        // -32603 and tell the reader nothing about which of the two failures this is.
        expect(ResourceNotFoundError.isInstance(failure)).toBe(false);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/Could not reach the task API/);
        await offline.close();
    });
});

describe('completion on id', () => {
    it('9: suggests the ids that start with what was typed, and nothing for a miss', async () => {
        const client = await connectModern();
        const first = await createTask(client, { title: 'one' });
        await createTask(client, { title: 'two' });

        const hit = await client.complete({
            ref: { type: 'ref/resource', uri: TASK_URI_TEMPLATE },
            argument: { name: 'id', value: first.id.slice(0, 8) },
        });
        const miss = await client.complete({
            ref: { type: 'ref/resource', uri: TASK_URI_TEMPLATE },
            argument: { name: 'id', value: 'zzzzzzzz' },
        });

        expect(hit.completion.values).toEqual([first.id]);
        expect(miss.completion.values).toEqual([]);
    });

    it('10: an unreachable task API produces no suggestions rather than an error', async () => {
        const offline = await connectToOfflineApi();

        const result = await offline.client.complete({
            ref: { type: 'ref/resource', uri: TASK_URI_TEMPLATE },
            argument: { name: 'id', value: 'anything' },
        });

        // Completion fires per keystroke. An outage degrades to no suggestions; it does not turn
        // typing into an error per character.
        expect(result.completion.values).toEqual([]);
        await offline.close();
    });
});

describe('capabilities and coexistence', () => {
    it('11: resources is declared with listChanged false and no subscribe', async () => {
        const client = await connectModern();

        const capabilities = client.getServerCapabilities();

        // This server builds one instance per request and discards it: there is nothing to send a
        // list_changed notification from, and nothing to hold a subscription. Saying otherwise
        // makes a client open a stream and wait for refreshes that cannot arrive.
        expect(capabilities?.resources).toBeDefined();
        expect(capabilities?.resources?.listChanged).toBe(false);
        expect(capabilities?.resources?.subscribe ?? false).toBe(false);
    });

    it('12: a 2025-era client can list and read resources too', async () => {
        const client = await connectLegacy();
        const created = await createTask(client, { title: 'legacy readable' });

        const { resources } = await client.listResources(undefined, { cacheMode: 'bypass' });
        const result = await read(client, `${TASKS_URI}/${created.id}`);

        expect(client.getProtocolEra()).toBe('legacy');
        expect(resources.map((resource) => resource.uri)).toEqual([TASKS_URI]);
        expect(JSON.parse(textOf(result))).toMatchObject({ title: 'legacy readable' });
    });

    it('13: the five tools are untouched, and a tool write is visible through the resource', async () => {
        const client = await connectModern();

        const { tools } = await client.listTools(undefined, { cacheMode: 'bypass' });
        const created = await createTask(client, { title: 'written by a tool' });
        const result = await read(client, TASKS_URI);

        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'tasks_create',
            'tasks_delete',
            'tasks_get',
            'tasks_list',
            'tasks_update',
        ]);
        expect(JSON.parse(textOf(result))).toMatchObject([{ id: created.id }]);
    });
});
