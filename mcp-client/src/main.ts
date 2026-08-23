/**
 * DOM wiring, and the only module in this project allowed to touch `document`.
 *
 * Everything interesting — the schema-to-form mapping, the argument building, the message log —
 * lives in modules that are pure functions over data, so `vitest` can test them in Node with no
 * browser. This file is the thin layer that reads values out of inputs and writes text into
 * elements; if a bug needs a test, the fix is usually to move the logic out of here rather than to
 * reach for a browser test runner. Same split, same reason, as `http.ts` against `index.ts` in
 * mcp-server.
 */

import { Connection, describe, MODERN_PROTOCOL_VERSION, type Tool } from './connection.js';
import { MessageLog } from './log.js';
import { buildArguments, toFormModel, type FieldModel, type FormValues, type JsonSchema } from './schema-form.js';

const el = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (found === null) {
        throw new Error(`index.html is missing #${id}`);
    }
    return found as T;
};

const statusEl = el('status');
const statusText = el('status-text');
const toolList = el<HTMLUListElement>('tool-list');
const callTitle = el('call-title');
const callDescription = el('call-description');
const callForm = el<HTMLFormElement>('call-form');
const fieldsEl = el('fields');
const callButton = el<HTMLButtonElement>('call-button');
const resultEl = el<HTMLPreElement>('result');
const logList = el<HTMLUListElement>('log-list');

let tools: Tool[] = [];
let selected: Tool | undefined;
let fields: FieldModel[] = [];

const log = new MessageLog(renderLog);
const connection = new Connection(log, {
    onTools: (next) => {
        tools = next;
        renderToolList();
        // A list refresh must not silently swap the schema under a half-filled form: re-select
        // so the fields are rebuilt from the new schema, or clear if the tool is gone.
        if (selected !== undefined) {
            const still = tools.find((tool) => tool.name === selected?.name);
            if (still === undefined) {
                clearSelection();
            } else {
                select(still);
            }
        }
    },
    onConnected: (connected) => {
        // Negotiation is 'auto', so a legacy server still connects. Saying so is the whole point:
        // an unremarked LEGACY badge on a server that serves 2026-07-28 is what started this work.
        // A downgrade reads as a warning here, never as an ordinary green connection.
        if (connected.downgraded) {
            setStatus(
                'warning',
                `${connected.name} ${connected.version} · MCP ${connected.protocol} — `
                + `${connected.era.toUpperCase()} era, not ${MODERN_PROTOCOL_VERSION}`,
            );
            return;
        }
        setStatus('connected', `${connected.name} ${connected.version} · MCP ${connected.protocol}`);
    },
    onError: (message) => setStatus('error', message),
});

function setStatus(state: 'connecting' | 'connected' | 'warning' | 'error', text: string): void {
    statusEl.dataset['state'] = state;
    statusText.textContent = text;
}

function renderToolList(): void {
    toolList.replaceChildren();
    if (tools.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'no tools';
        toolList.append(empty);
        return;
    }
    for (const tool of tools) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = tool.name;
        button.setAttribute('aria-pressed', String(tool.name === selected?.name));
        button.addEventListener('click', () => select(tool));
        item.append(button);
        toolList.append(item);
    }
}

function clearSelection(): void {
    selected = undefined;
    fields = [];
    callTitle.textContent = 'Select a tool';
    callDescription.textContent = '';
    callForm.hidden = true;
    resultEl.hidden = true;
    renderToolList();
}

function select(tool: Tool): void {
    selected = tool;
    fields = toFormModel(tool.inputSchema as JsonSchema | undefined);

    callTitle.textContent = tool.name;
    // textContent, never innerHTML: tool descriptions come off the wire. This one is our own
    // server today, but a client that renders server-supplied text as markup is a client with an
    // injection bug waiting for a different server.
    callDescription.textContent = tool.description ?? '';
    resultEl.hidden = true;
    renderFields();
    callForm.hidden = false;
    renderToolList();
}

function renderFields(): void {
    fieldsEl.replaceChildren();
    for (const field of fields) {
        fieldsEl.append(renderField(field));
    }
}

function renderField(field: FieldModel): HTMLLabelElement {
    const label = document.createElement('label');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = field.name;
    label.append(name);

    if (field.required) {
        const mark = document.createElement('span');
        mark.className = 'req';
        mark.textContent = ' *';
        label.append(mark);
    }

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = field.kind === 'unsupported'
        ? `${field.description} — not renderable: ${field.reason}`
        : field.description;
    label.append(hint);

    if (field.kind === 'enum') {
        const select_ = document.createElement('select');
        select_.name = field.name;
        // An empty first option is what makes "leave it unset" reachable on an optional enum, and
        // omitting a field is not the same as sending its default -- see schema-form.ts.
        if (!field.required) {
            const blank = document.createElement('option');
            blank.value = '';
            blank.textContent = '(omit)';
            select_.append(blank);
        }
        for (const option of field.options) {
            const choice = document.createElement('option');
            choice.value = option;
            choice.textContent = option;
            select_.append(choice);
        }
        label.append(select_);
        return label;
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.name = field.name;
    input.autocomplete = 'off';
    if (field.kind === 'unsupported') {
        input.disabled = true;
        input.placeholder = field.reason;
    }
    label.append(input);
    return label;
}

function readValues(): FormValues {
    const values: FormValues = {};
    for (const field of fields) {
        const control = callForm.elements.namedItem(field.name);
        values[field.name] = control instanceof HTMLInputElement || control instanceof HTMLSelectElement
            ? control.value
            : '';
    }
    return values;
}

function markInvalid(names: string[]): void {
    for (const field of fields) {
        const control = callForm.elements.namedItem(field.name);
        if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
            control.setAttribute('aria-invalid', String(names.includes(field.name)));
        }
    }
}

function showResult(text: string, isError: boolean): void {
    resultEl.textContent = text;
    resultEl.dataset['error'] = String(isError);
    resultEl.hidden = false;
}

callForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (selected === undefined) {
        return;
    }

    const built = buildArguments(fields, readValues());
    if (!built.ok) {
        markInvalid(built.missing);
        showResult(`Required and empty: ${built.missing.join(', ')}. Nothing was sent.`, true);
        return;
    }
    markInvalid([]);

    void call(selected.name, built.args);
});

async function call(name: string, args: Record<string, unknown>): Promise<void> {
    const client = connection.client;
    if (client === undefined) {
        showResult('Not connected.', true);
        return;
    }

    callButton.disabled = true;
    showResult('calling…', false);
    try {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content ?? [])
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
        // A tool that ran and failed reports `isError` with a message the server wrote for a
        // reader. Show that message, not "request failed" and not the whole envelope.
        showResult(text === '' ? JSON.stringify(result, null, 2) : text, result.isError === true);
    } catch (error) {
        // Getting here means the call never produced a tool result -- a transport or protocol
        // failure. Distinct from the branch above on purpose; they need different fixes.
        showResult(`The call did not reach the server: ${describe(error)}`, true);
    } finally {
        callButton.disabled = false;
    }
}

function renderLog(): void {
    logList.replaceChildren();
    const entries = log.entries();
    if (entries.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'no messages yet';
        logList.append(empty);
        return;
    }
    for (const exchange of entries) {
        const item = document.createElement('li');

        const method = document.createElement('span');
        method.className = 'method';
        method.textContent = exchange.method;

        const state = document.createElement('span');
        state.className = 'state';
        state.dataset['state'] = exchange.state;
        // "streaming" rather than a duration: subscriptions/listen answers its headers in
        // milliseconds and then stays open for the life of the connection. Showing 4ms would say
        // it finished, and showing it pending would say it is stuck. It is listening.
        state.textContent = exchange.state === 'streaming' ? 'streaming' : exchange.state;

        const took = document.createElement('span');
        took.className = 'took';
        took.textContent = exchange.state === 'streaming' || exchange.durationMs === undefined
            ? ''
            : `${exchange.durationMs}ms`;

        item.append(method, state, took);

        if (exchange.detail !== undefined) {
            const detail = document.createElement('span');
            detail.className = 'detail';
            detail.textContent = exchange.detail;
            item.append(detail);
        }
        logList.append(item);
    }
}

el('clear-log').addEventListener('click', () => log.clear());

clearSelection();
renderLog();
setStatus('connecting', 'negotiating…');
connection.connect().catch(() => {
    // The handler already put the reason on the page; this stops an unhandled rejection.
});
