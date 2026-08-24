/**
 * Obligations 14-17 of vault/specs/mcp-resources.md.
 *
 * The wire shapes below are the real ones the tasks server publishes — captured from a live
 * `resources/list` and `resources/templates/list` — for the same reason `schema-form.test.ts` uses
 * real schemas: a renderer tested against shapes nobody serves proves nothing about the page.
 */

import { describe, expect, it } from 'vitest';

import { ResourceNotFoundError } from '@modelcontextprotocol/client';

import {
    classifyReadFailure,
    contentsToText,
    expandTemplate,
    loadResources,
    toResourcesModel,
    variablesOf,
    type ResourceReader,
} from '../src/resources.js';

const TASKS_RESOURCE = {
    uri: 'tasks://tasks',
    name: 'tasks',
    title: 'All tasks',
    description:
        'Every task, as a JSON array. The same data tasks_list returns, as material to read rather '
        + 'than an action to take.',
    mimeType: 'application/json',
};

const TASK_TEMPLATE = {
    uriTemplate: 'tasks://tasks/{id}',
    name: 'task',
    title: 'Task by id',
    description: 'A single task as JSON, by the UUID that tasks_list and tasks://tasks return.',
    mimeType: 'application/json',
};

/** A stand-in `Client`. Counts calls, so "asked for nothing" is something a test can assert. */
function reader(options: {
    capabilities?: { resources?: unknown };
    fail?: boolean;
}): ResourceReader & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        getServerCapabilities: () => options.capabilities,
        listResources: async () => {
            calls.push('resources/list');
            if (options.fail === true) {
                throw new Error('the server said no');
            }
            return { resources: [TASKS_RESOURCE] };
        },
        listResourceTemplates: async () => {
            calls.push('resources/templates/list');
            if (options.fail === true) {
                throw new Error('the server said no');
            }
            return { resourceTemplates: [TASK_TEMPLATE] };
        },
    };
}

describe('14: what the server offers to read becomes something a panel can render', () => {
    it('separates fixed URIs from templates and keeps name, description and type', () => {
        const model = toResourcesModel([TASKS_RESOURCE], [TASK_TEMPLATE]);

        expect(model.resources).toEqual([
            {
                name: 'tasks',
                uri: 'tasks://tasks',
                description: TASKS_RESOURCE.description,
                mimeType: 'application/json',
            },
        ]);
        expect(model.templates).toEqual([
            {
                name: 'task',
                uriTemplate: 'tasks://tasks/{id}',
                description: TASK_TEMPLATE.description,
                mimeType: 'application/json',
                variables: ['id'],
            },
        ]);
    });

    it('falls back to the URI when the server names nothing', () => {
        const model = toResourcesModel([{ uri: 'tasks://tasks' }], [{ uriTemplate: 'tasks://tasks/{id}' }]);

        expect(model.resources[0]?.name).toBe('tasks://tasks');
        expect(model.templates[0]?.name).toBe('tasks://tasks/{id}');
    });
});

describe('15: a template is filled in the way a read would', () => {
    it('reads the variables off the template and expands to the URI the server matches', () => {
        expect(variablesOf('tasks://tasks/{id}')).toEqual(['id']);

        const expanded = expandTemplate('tasks://tasks/{id}', { id: '3f9a2c1e-0000-4000-8000-000000000001' });

        expect(expanded).toEqual({ ok: true, uri: 'tasks://tasks/3f9a2c1e-0000-4000-8000-000000000001' });
    });

    it('percent-encodes a value that needs it', () => {
        const expanded = expandTemplate('tasks://tasks/{id}', { id: 'a b/c' });

        expect(expanded).toEqual({ ok: true, uri: 'tasks://tasks/a%20b%2Fc' });
    });

    it('refuses a blank variable rather than reading tasks://tasks/', () => {
        // Expanding it would ask the server for something that cannot exist, and the error would
        // blame the server for a field the person had simply not filled in.
        expect(expandTemplate('tasks://tasks/{id}', { id: '  ' })).toEqual({ ok: false, missing: ['id'] });
    });

    it('reports no variables for a template it cannot parse, rather than guessing', () => {
        expect(variablesOf('tasks://tasks/{')).toEqual([]);
    });
});

describe('16: an absent resource is told apart from a broken client', () => {
    it('classifies the SDK error as not-found', () => {
        const error = new ResourceNotFoundError('tasks://tasks/nope');

        expect(classifyReadFailure(error, 'tasks://tasks/nope')).toMatchObject({
            kind: 'not-found',
            uri: 'tasks://tasks/nope',
        });
    });

    it('classifies a bare -32602 with data.uri as not-found, from either code', () => {
        for (const code of [-32602, -32002]) {
            const error = Object.assign(new Error('Resource not found'), {
                code,
                data: { uri: 'tasks://tasks/nope' },
            });

            expect(classifyReadFailure(error, 'tasks://tasks/nope')).toMatchObject({ kind: 'not-found' });
        }
    });

    it('leaves an ordinary Invalid Params and a transport failure as failures', () => {
        // A -32602 without data.uri means the request was wrong, not that the resource is absent.
        const invalidParams = Object.assign(new Error('Invalid params'), { code: -32602 });
        expect(classifyReadFailure(invalidParams, 'tasks://tasks')).toMatchObject({ kind: 'failed' });

        const offline = new Error('Failed to fetch');
        const classified = classifyReadFailure(offline, 'tasks://tasks');
        expect(classified.kind).toBe('failed');
        expect(classified.message).toContain('tasks://tasks');
        expect(classified.message).toContain('Failed to fetch');
    });

    it('says what non-text content is instead of rendering base64 as the document', () => {
        expect(contentsToText([{ text: '[]' }])).toBe('[]');
        expect(contentsToText([])).toContain('no contents');
        expect(contentsToText([{ blob: 'AAAA', mimeType: 'image/png' }])).toContain('image/png');
    });
});

describe('17: a server without resources is not asked for any', () => {
    it('produces an empty model and sends no request', async () => {
        const client = reader({ capabilities: { } });

        const loaded = await loadResources(client);

        expect(loaded).toEqual({ model: { resources: [], templates: [] } });
        // The point of the obligation: -32601 at a server that is behaving correctly is not a
        // debugging tool doing its job.
        expect(client.calls).toEqual([]);
    });

    it('asks when the capability is there', async () => {
        const client = reader({ capabilities: { resources: { listChanged: false } } });

        const loaded = await loadResources(client);

        expect(client.calls.sort()).toEqual(['resources/list', 'resources/templates/list']);
        expect(loaded.model.resources).toHaveLength(1);
        expect(loaded.model.templates).toHaveLength(1);
        expect(loaded.error).toBeUndefined();
    });

    it('reports a failed listing as panel text, not as a thrown error', async () => {
        const client = reader({ capabilities: { resources: {} }, fail: true });

        const loaded = await loadResources(client);

        expect(loaded.model).toEqual({ resources: [], templates: [] });
        expect(loaded.error).toContain('the server said no');
    });
});
