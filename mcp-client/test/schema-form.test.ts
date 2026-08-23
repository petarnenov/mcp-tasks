/**
 * Obligations 5-7 of vault/specs/mcp-client.md.
 *
 * The schemas below are the real ones the tasks server publishes — captured from a live
 * `tools/list` — not invented shapes. A form renderer tested against schemas nobody serves proves
 * nothing about the page a person actually uses.
 */

import { describe, expect, it } from 'vitest';

import { buildArguments, toFormModel, type JsonSchema } from '../src/schema-form.js';

/** `tasks_update`'s schema, verbatim from the server. The richest of the five. */
const TASKS_UPDATE: JsonSchema = {
    type: 'object',
    properties: {
        id: { type: 'string', description: "The task's UUID, as returned by tasks_list" },
        title: { type: 'string', description: 'Short title. Required, max 200 characters' },
        description: { type: 'string', description: 'Optional longer description. Omit to clear it' },
        status: { type: 'string', description: 'One of TODO, IN_PROGRESS, DONE. Omit to reset to TODO', enum: ['TODO', 'IN_PROGRESS', 'DONE'] },
        priority: { type: 'string', description: 'One of LOW, MEDIUM, HIGH. Omit to reset to MEDIUM', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    },
    required: ['id', 'title'],
};

const TASKS_LIST: JsonSchema = { type: 'object', properties: {} };

describe('5: every argument the five tools use gets a usable control', () => {
    it('maps strings to text, enums to a choice list, and marks what is required', () => {
        const fields = toFormModel(TASKS_UPDATE);

        expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
            ['id', 'text', true],
            ['title', 'text', true],
            ['description', 'text', false],
            ['status', 'enum', false],
            ['priority', 'enum', false],
        ]);
    });

    it('carries the enum values through exactly, adding and dropping nothing', () => {
        const status = toFormModel(TASKS_UPDATE).find((f) => f.name === 'status');

        expect(status?.kind).toBe('enum');
        expect(status?.kind === 'enum' ? status.options : []).toEqual(['TODO', 'IN_PROGRESS', 'DONE']);
    });

    it('keeps the schema order rather than floating required fields to the top', () => {
        // The server writes these in the order a person fills them in. Reordering loses that.
        expect(toFormModel(TASKS_UPDATE).map((f) => f.name))
            .toEqual(['id', 'title', 'description', 'status', 'priority']);
    });

    it('carries each description through, since it is the only place a model or a person reads it', () => {
        const description = toFormModel(TASKS_UPDATE).find((f) => f.name === 'description');

        expect(description?.description).toBe('Optional longer description. Omit to clear it');
    });

    it('handles a tool with no arguments at all', () => {
        expect(toFormModel(TASKS_LIST)).toEqual([]);
        expect(toFormModel(undefined)).toEqual([]);
    });

    it('reports a shape it cannot render instead of guessing at one', () => {
        const fields = toFormModel({
            type: 'object',
            properties: { count: { type: 'number' }, tags: { type: 'array' } },
        });

        expect(fields.map((f) => f.kind)).toEqual(['unsupported', 'unsupported']);
        expect(fields[0]?.kind === 'unsupported' ? fields[0].reason : '').toMatch(/number/);
    });
});

describe('6: an omitted optional field is omitted, not sent empty', () => {
    // The obligation with teeth. tasks_update is a full replace: the server resets what it does
    // not receive, but "" is a value. A form that sent every input would blank out titles and
    // descriptions while the person believed they were changing one field.
    it('drops blank optionals from the arguments object entirely', () => {
        const fields = toFormModel(TASKS_UPDATE);

        const built = buildArguments(fields, {
            id: 'a-uuid',
            title: 'renamed',
            description: '',
            status: '',
            priority: '',
        });

        expect(built.ok).toBe(true);
        expect(built.ok && built.args).toEqual({ id: 'a-uuid', title: 'renamed' });
    });

    it('does not smuggle a blank in as null or an empty string', () => {
        const built = buildArguments(toFormModel(TASKS_UPDATE), { id: 'x', title: 't', description: '' });

        const args = built.ok ? built.args : {};
        expect(Object.hasOwn(args, 'description')).toBe(false);
        expect(JSON.stringify(args)).not.toContain('""');
        expect(JSON.stringify(args)).not.toContain('null');
    });

    it('keeps an optional the person did fill in', () => {
        const built = buildArguments(toFormModel(TASKS_UPDATE), {
            id: 'x', title: 't', description: 'kept', status: 'DONE', priority: '',
        });

        expect(built.ok && built.args).toEqual({ id: 'x', title: 't', description: 'kept', status: 'DONE' });
    });
});

describe('7: a required field left empty is refused before anything is sent', () => {
    it('names every missing required field, not just the first', () => {
        const built = buildArguments(toFormModel(TASKS_UPDATE), { id: '', title: '' });

        expect(built.ok).toBe(false);
        expect(built.ok ? [] : built.missing).toEqual(['id', 'title']);
    });

    it('treats whitespace as empty, since the server rejects a blank title anyway', () => {
        const built = buildArguments(toFormModel(TASKS_UPDATE), { id: 'x', title: '   ' });

        expect(built.ok ? [] : built.missing).toEqual(['title']);
    });

    it('accepts a form with every required field filled and every optional blank', () => {
        expect(buildArguments(toFormModel(TASKS_UPDATE), { id: 'x', title: 't' }).ok).toBe(true);
    });
});
