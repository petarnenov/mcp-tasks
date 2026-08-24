/**
 * The prompt obligations from `vault/specs/mcp-prompts.md`, driven by a real MCP client.
 *
 * Its own file, numbering into its own spec — the rule [[QUALITY]] states, and the reason
 * `resources.test.ts` is separate from `mcp-server.test.ts`.
 */

import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { createMcpHttpServer, type McpHttpServer } from '../src/http.js';
import { PLAN_INSTRUCTION, TRIAGE_INSTRUCTION } from '../src/prompts.js';
import { TASKS_URI } from '../src/resources.js';
import { startStubTasksApi, type StubTasksApi } from './stub-tasks-api.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

let api: StubTasksApi;
let mcp: McpHttpServer;
let mcpUrl: URL;
const openClients: Client[] = [];

beforeAll(async () => {
    api = await startStubTasksApi();
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
        { name: 'mcp-prompts-test', version: '0.1.0' },
        { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
    );
    openClients.push(client);
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    return client;
}

async function connectLegacy(): Promise<Client> {
    const client = new Client({ name: 'mcp-prompts-test-legacy', version: '0.1.0' });
    openClients.push(client);
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    return client;
}

async function connectToOfflineApi(): Promise<{ client: Client; close: () => Promise<void> }> {
    const offline = createMcpHttpServer({ tasksApiUrl: 'http://127.0.0.1:1', onerror: () => {} });
    await new Promise<void>((resolve) => offline.server.listen(0, '127.0.0.1', resolve));
    const client = new Client({ name: 'offline-prompts-test', version: '0.1.0' });
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

interface PromptMessages {
    description?: string;
    messages: { role: string; content: Record<string, unknown> }[];
}

/** The instruction block and the embedded resource block, named rather than indexed at each use. */
function blocks(result: PromptMessages): {
    instruction: string;
    resource: { uri?: string; mimeType?: string; text?: string };
} {
    const text = result.messages.find((message) => message.content['type'] === 'text');
    const embedded = result.messages.find((message) => message.content['type'] === 'resource');
    return {
        instruction: (text?.content['text'] as string | undefined) ?? '',
        resource: (embedded?.content['resource'] as Record<string, string> | undefined) ?? {},
    };
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

describe('the prompt surface', () => {
    it('1: prompts/list returns exactly the two prompts, with their arguments', async () => {
        const client = await connectModern();

        const { prompts } = await client.listPrompts(undefined, { cacheMode: 'bypass' });

        expect(prompts.map((prompt) => prompt.name).sort()).toEqual(['plan_task', 'triage_tasks']);
        const triage = prompts.find((prompt) => prompt.name === 'triage_tasks');
        const plan = prompts.find((prompt) => prompt.name === 'plan_task');

        expect(triage?.description).toBeTruthy();
        expect(triage?.arguments ?? []).toEqual([]);
        expect(plan?.description).toBeTruthy();
        expect(plan?.arguments).toEqual([
            { name: 'id', description: expect.stringContaining('UUID'), required: true },
        ]);
    });

    it('2: prompts/list does not call the task API, and answers while the api is down', async () => {
        const client = await connectModern();
        await createTask(client, { title: 'not fetched by a listing' });
        const before = api.requests.length;

        const { prompts } = await client.listPrompts(undefined, { cacheMode: 'bypass' });

        // Free here rather than designed, unlike resources/list: the arguments come off the schema
        // and the api is only touched when a prompt is actually fetched.
        expect(prompts).toHaveLength(2);
        expect(api.requests.length).toBe(before);

        const offline = await connectToOfflineApi();
        const offlineList = await offline.client.listPrompts(undefined, { cacheMode: 'bypass' });
        expect(offlineList.prompts).toHaveLength(2);
        await offline.close();
    });
});

describe('getting a prompt', () => {
    it('3: triage_tasks embeds tasks://tasks, byte-identical to reading it', async () => {
        const client = await connectModern();
        await createTask(client, { title: 'first' });
        await createTask(client, { title: 'second', priority: 'HIGH' });

        const prompt = (await client.getPrompt({ name: 'triage_tasks' })) as PromptMessages;
        const read = await client.readResource({ uri: TASKS_URI }, { cacheMode: 'bypass' });

        const { instruction, resource } = blocks(prompt);
        expect(instruction).toBe(TRIAGE_INSTRUCTION);
        expect(resource).toMatchObject({ uri: TASKS_URI, mimeType: 'application/json' });
        // One version of the data whichever door it came through.
        expect(resource.text).toBe(read.contents[0]?.text);
        expect(JSON.parse(resource.text ?? '')).toHaveLength(2);
    });

    it('4: plan_task embeds that one task, byte-identical to reading it', async () => {
        const client = await connectModern();
        const created = await createTask(client, { title: 'plannable', description: 'with detail' });
        const uri = `${TASKS_URI}/${created.id}`;

        const prompt = (await client.getPrompt({
            name: 'plan_task',
            arguments: { id: created.id },
        })) as PromptMessages;
        const read = await client.readResource({ uri }, { cacheMode: 'bypass' });

        const { instruction, resource } = blocks(prompt);
        expect(instruction).toBe(PLAN_INSTRUCTION);
        expect(resource).toMatchObject({ uri, mimeType: 'application/json' });
        expect(resource.text).toBe(read.contents[0]?.text);
        expect(prompt.description).toContain(created.id);
    });

    it('5: the instructions say not to write, and warn that tasks_update replaces', async () => {
        const client = await connectModern();
        await createTask(client, { title: 'anything' });

        const triage = blocks((await client.getPrompt({ name: 'triage_tasks' })) as PromptMessages);
        const created = await createTask(client, { title: 'planned' });
        const plan = blocks(
            (await client.getPrompt({ name: 'plan_task', arguments: { id: created.id } })) as PromptMessages,
        );

        // Asserted on the text because the property IS the text: the same connection carries
        // tasks_update and tasks_delete, and a prompt that reads as an instruction to act gets
        // acted on.
        expect(triage.instruction).toContain('Do not change anything.');
        expect(triage.instruction).toMatch(/tasks_update is a full replace/);
        expect(triage.instruction).toMatch(/every field/);
        expect(plan.instruction).toContain('Do not create anything.');
    });

    it('6: an unknown id fails with -32602 and no data.uri', async () => {
        const client = await connectModern();

        const failure = await client
            .getPrompt({ name: 'plan_task', arguments: { id: '00000000-0000-0000-0000-000000000000' } })
            .then(() => undefined, (error: unknown) => error);

        expect((failure as { code?: number }).code).toBe(-32602);
        expect((failure as Error).message).toMatch(/No task with id/);
        // The trap this obligation exists for: ResourceNotFoundError would carry data {uri}, which
        // is how a client is told a RESOURCE is absent. What is absent here is a task.
        expect((failure as { data?: unknown }).data).toBeUndefined();
    });

    it('7: a missing required argument fails before the handler runs', async () => {
        const client = await connectModern();
        const before = api.requests.length;

        const failure = await client
            .getPrompt({ name: 'plan_task' })
            .then(() => undefined, (error: unknown) => error);

        expect((failure as { code?: number }).code).toBe(-32602);
        // Not /id/ -- that matches the word "Invalid" and would pass against any schema error.
        expect((failure as Error).message).toMatch(/Invalid arguments for prompt plan_task/);
        // The SDK rejects it against the schema, so nothing downstream is asked for anything.
        expect(api.requests.length).toBe(before);
    });

    it('7b: an empty id is refused by the schema, not sent to the api', async () => {
        const client = await connectModern();
        await createTask(client, { title: 'would have been embedded' });
        const before = api.requests.length;

        const failure = await client
            .getPrompt({ name: 'plan_task', arguments: { id: '' } })
            .then(() => undefined, (error: unknown) => error);

        // Without .min(1) this SUCCEEDS: "" reaches the api as GET /tasks/, which Micronaut
        // answers with the whole list, and the prompt embeds every task under tasks://tasks/
        // beneath an instruction to plan one of them. A wrong answer with no error anywhere.
        expect((failure as { code?: number }).code).toBe(-32602);
        expect((failure as Error).message).toMatch(/id/);
        expect(api.requests.length).toBe(before);
    });

    it('8: an unreachable task API is a readable message, distinct from an unknown id', async () => {
        const offline = await connectToOfflineApi();

        const failure = await offline.client
            .getPrompt({ name: 'triage_tasks' })
            .then(() => undefined, (error: unknown) => error);

        expect((failure as Error).message).toMatch(/Could not reach the task API/);
        expect((failure as { code?: number }).code).not.toBe(-32602);
        await offline.close();
    });
});

describe('completion on the id argument', () => {
    it('9: suggests the ids that start with what was typed, and nothing for a miss', async () => {
        const client = await connectModern();
        const first = await createTask(client, { title: 'one' });
        await createTask(client, { title: 'two' });

        const hit = await client.complete({
            ref: { type: 'ref/prompt', name: 'plan_task' },
            argument: { name: 'id', value: first.id.slice(0, 8) },
        });
        const miss = await client.complete({
            ref: { type: 'ref/prompt', name: 'plan_task' },
            argument: { name: 'id', value: 'zzzzzzzz' },
        });

        expect(hit.completion.values).toEqual([first.id]);
        expect(miss.completion.values).toEqual([]);
    });

    it('10: an unreachable task API produces no suggestions rather than an error', async () => {
        const offline = await connectToOfflineApi();

        const result = await offline.client.complete({
            ref: { type: 'ref/prompt', name: 'plan_task' },
            argument: { name: 'id', value: 'anything' },
        });

        expect(result.completion.values).toEqual([]);
        await offline.close();
    });
});

describe('capabilities and coexistence', () => {
    it('11: prompts is declared with listChanged false, and completions is declared', async () => {
        const client = await connectModern();

        const capabilities = client.getServerCapabilities();

        expect(capabilities?.prompts).toBeDefined();
        expect(capabilities?.prompts?.listChanged).toBe(false);
        // Declared by the SDK itself, because plan_task's id and the resource template's id are
        // both completable.
        expect(capabilities?.completions).toBeDefined();
    });

    it('12: a 2025-era client can list and get both prompts', async () => {
        const client = await connectLegacy();
        const created = await createTask(client, { title: 'legacy plannable' });

        const { prompts } = await client.listPrompts(undefined, { cacheMode: 'bypass' });
        const plan = blocks(
            (await client.getPrompt({ name: 'plan_task', arguments: { id: created.id } })) as PromptMessages,
        );

        expect(client.getProtocolEra()).toBe('legacy');
        expect(prompts.map((prompt) => prompt.name).sort()).toEqual(['plan_task', 'triage_tasks']);
        expect(JSON.parse(plan.resource.text ?? '')).toMatchObject({ title: 'legacy plannable' });
    });

    it('13: the tools and resources are untouched', async () => {
        const client = await connectModern();

        const { tools } = await client.listTools(undefined, { cacheMode: 'bypass' });
        const { resources } = await client.listResources(undefined, { cacheMode: 'bypass' });
        const { resourceTemplates } = await client.listResourceTemplates(undefined, { cacheMode: 'bypass' });

        expect(tools).toHaveLength(5);
        expect(resources.map((resource) => resource.uri)).toEqual([TASKS_URI]);
        expect(resourceTemplates).toHaveLength(1);
    });
});
