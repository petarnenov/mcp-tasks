/**
 * Obligations 14-17 of vault/specs/mcp-prompts.md.
 *
 * The wire shapes below are the real ones the tasks server publishes — captured from a live
 * `prompts/list` and `prompts/get` — for the same reason the other two suites use real shapes.
 */

import { describe, expect, it } from 'vitest';

import {
    buildPromptArguments,
    loadPrompts,
    toPromptModels,
    toRenderedBlocks,
    type PromptReader,
} from '../src/prompts.js';

const TRIAGE = {
    name: 'triage_tasks',
    title: 'Triage the task list',
    description:
        'Look at every task and say which are in the wrong state, then what to do next. Reads only '
        + '— it proposes changes rather than making them.',
};

const PLAN = {
    name: 'plan_task',
    title: 'Plan one task',
    description: 'Break a single task down into the steps needed to finish it. Reads only.',
    arguments: [
        {
            name: 'id',
            description: "The task's UUID, as returned by tasks_list or the tasks://tasks resource",
            required: true,
        },
    ],
};

function reader(options: { capabilities?: { prompts?: unknown }; fail?: boolean }): PromptReader & {
    calls: string[];
} {
    const calls: string[] = [];
    return {
        calls,
        getServerCapabilities: () => options.capabilities,
        listPrompts: async () => {
            calls.push('prompts/list');
            if (options.fail === true) {
                throw new Error('the server said no');
            }
            return { prompts: [TRIAGE, PLAN] };
        },
    };
}

describe('14: what the server offers as prompts becomes something a panel can render', () => {
    it('carries the description and marks which arguments are required', () => {
        const models = toPromptModels([TRIAGE, PLAN]);

        expect(models[0]).toEqual({
            name: 'triage_tasks',
            title: 'Triage the task list',
            description: TRIAGE.description,
            args: [],
        });
        expect(models[1]?.args).toEqual([
            { name: 'id', description: PLAN.arguments[0]?.description, required: true },
        ]);
    });

    it('falls back to the name when the server titles nothing', () => {
        const models = toPromptModels([{ name: 'bare' }]);

        expect(models[0]).toEqual({ name: 'bare', title: 'bare', description: '', args: [] });
    });
});

describe('15: the form is checked here, not by a round trip', () => {
    const args = toPromptModels([PLAN])[0]!.args;

    it('refuses a required argument left blank, naming it', () => {
        expect(buildPromptArguments(args, { id: '   ' })).toEqual({ ok: false, missing: ['id'] });
    });

    it('builds the arguments object prompts/get expects', () => {
        expect(buildPromptArguments(args, { id: 'abc-123' })).toEqual({
            ok: true,
            args: { id: 'abc-123' },
        });
    });

    it('omits a blank optional argument rather than sending an empty string', () => {
        const optional = toPromptModels([
            { name: 'p', arguments: [{ name: 'note', required: false }] },
        ])[0]!.args;

        // An empty string is a value, and the prompt cannot tell it apart from a deliberate one.
        expect(buildPromptArguments(optional, { note: '' })).toEqual({ ok: true, args: {} });
    });
});

describe('16: the returned messages flatten for rendering', () => {
    it('renders text, an embedded resource with its URI and body, and a link', () => {
        const blocks = toRenderedBlocks([
            { role: 'user', content: { type: 'text', text: 'Triage it.' } },
            {
                role: 'user',
                content: {
                    type: 'resource',
                    resource: { uri: 'tasks://tasks', mimeType: 'application/json', text: '[]' },
                },
            },
            {
                role: 'user',
                content: { type: 'resource_link', uri: 'tasks://tasks/1', name: 'task' },
            },
        ]);

        expect(blocks[0]).toEqual({ role: 'user', kind: 'text', body: 'Triage it.' });
        expect(blocks[1]).toMatchObject({ kind: 'resource', uri: 'tasks://tasks', body: '[]' });
        expect(blocks[2]).toMatchObject({ kind: 'resource-link', uri: 'tasks://tasks/1' });
    });

    it('reports an unknown content type instead of dropping it', () => {
        const blocks = toRenderedBlocks([{ role: 'assistant', content: { type: 'audio', data: '…' } }]);

        // A client that silently discards what it does not understand lies about what the server
        // sent — and showing that is the whole job here.
        expect(blocks[0]).toMatchObject({ role: 'assistant', kind: 'unknown' });
        expect(blocks[0]?.body).toContain('audio');
    });

    it('names binary embedded content rather than printing base64', () => {
        const blocks = toRenderedBlocks([
            {
                role: 'user',
                content: {
                    type: 'resource',
                    resource: { uri: 'x://y', mimeType: 'image/png', blob: 'AAAA' },
                },
            },
        ]);

        expect(blocks[0]?.body).toContain('image/png');
        expect(blocks[0]?.body).not.toContain('AAAA');
    });
});

describe('17: a server without prompts is not asked for any', () => {
    it('produces an empty model and sends no request', async () => {
        const client = reader({ capabilities: {} });

        const loaded = await loadPrompts(client);

        expect(loaded).toEqual({ prompts: [] });
        expect(client.calls).toEqual([]);
    });

    it('asks when the capability is there', async () => {
        const client = reader({ capabilities: { prompts: { listChanged: false } } });

        const loaded = await loadPrompts(client);

        expect(client.calls).toEqual(['prompts/list']);
        expect(loaded.prompts.map((prompt) => prompt.name)).toEqual(['triage_tasks', 'plan_task']);
        expect(loaded.error).toBeUndefined();
    });

    it('reports a failed listing as panel text, not as a thrown error', async () => {
        const client = reader({ capabilities: { prompts: {} }, fail: true });

        const loaded = await loadPrompts(client);

        expect(loaded.prompts).toEqual([]);
        expect(loaded.error).toContain('the server said no');
    });
});
