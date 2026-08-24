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
import {
    buildPromptArguments,
    toRenderedBlocks,
    type PromptModel,
    type RenderedBlock,
} from './prompts.js';
import {
    classifyReadFailure,
    contentsToText,
    expandTemplate,
    NO_RESOURCES,
    type ResourcesModel,
    type StaticResourceModel,
    type TemplateResourceModel,
} from './resources.js';
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
const resourcesNote = el('resources-note');
const resourceList = el<HTMLUListElement>('resource-list');
const resourceForm = el<HTMLFormElement>('resource-form');
const resourceFields = el('resource-fields');
const resourceButton = el<HTMLButtonElement>('resource-button');
const resourceBody = el<HTMLPreElement>('resource-body');
const promptsNote = el('prompts-note');
const promptList = el<HTMLUListElement>('prompt-list');
const promptForm = el<HTMLFormElement>('prompt-form');
const promptFields = el('prompt-fields');
const promptButton = el<HTMLButtonElement>('prompt-button');
const promptMessages = el('prompt-messages');

let tools: Tool[] = [];
let selected: Tool | undefined;
let fields: FieldModel[] = [];
let resources: ResourcesModel = NO_RESOURCES;
/** False until the server has answered. "No resources" and "not asked yet" must not look alike. */
let resourcesLoaded = false;
let prompts: PromptModel[] = [];
let promptsLoaded = false;
let selectedPrompt: PromptModel | undefined;
/** What the Read button will read: a fixed URI, or a template whose variables need filling in. */
let selectedResource: { kind: 'static'; resource: StaticResourceModel }
    | { kind: 'template'; template: TemplateResourceModel }
    | undefined;

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
    onResources: (next, error) => {
        resources = next;
        resourcesLoaded = true;
        renderResources(error);
    },
    onPrompts: (next, error) => {
        prompts = next;
        promptsLoaded = true;
        renderPrompts(error);
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

/* ---- resources ---------------------------------------------------------------------------- */

function renderResources(error?: string): void {
    if (error !== undefined) {
        showNote(error);
    } else if (!resourcesLoaded) {
        showNote('waiting for the connection…');
    } else if (resources.resources.length === 0 && resources.templates.length === 0) {
        showNote('This server exposes no resources.');
    } else {
        resourcesNote.hidden = true;
    }

    resourceList.replaceChildren();
    for (const resource of resources.resources) {
        resourceList.append(
            resourceEntry(resource.name, resource.uri, resource.description, () =>
                selectResource({ kind: 'static', resource }),
            ),
        );
    }
    for (const template of resources.templates) {
        resourceList.append(
            resourceEntry(template.name, template.uriTemplate, template.description, () =>
                selectResource({ kind: 'template', template }),
            ),
        );
    }
}

function showNote(text: string): void {
    resourcesNote.textContent = text;
    resourcesNote.hidden = false;
}

function resourceEntry(name: string, uri: string, description: string, onSelect: () => void): HTMLLIElement {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(uri === selectedUri()));
    // textContent throughout: names, URIs and descriptions all come off the wire.
    button.textContent = uri;

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = description === '' ? name : `${name} — ${description}`;
    button.append(kind);

    button.addEventListener('click', onSelect);
    item.append(button);
    return item;
}

function selectedUri(): string | undefined {
    if (selectedResource === undefined) {
        return undefined;
    }
    return selectedResource.kind === 'static'
        ? selectedResource.resource.uri
        : selectedResource.template.uriTemplate;
}

function selectResource(next: NonNullable<typeof selectedResource>): void {
    selectedResource = next;
    resourceBody.hidden = true;
    resourceFields.replaceChildren();

    if (next.kind === 'static') {
        // Nothing to fill in, so nothing to submit: reading is the click itself.
        resourceForm.hidden = true;
        renderResources();
        void readResource(next.resource.uri);
        return;
    }

    for (const variable of next.template.variables) {
        resourceFields.append(renderVariable(next.template, variable));
    }
    resourceForm.hidden = false;
    renderResources();
}

/**
 * One input per template variable, with a datalist the server fills in.
 *
 * The suggestions come from `completion/complete`, which is the server's job and not a guess made
 * here — it is also why this input is not simply a text box: task ids are UUIDs, and typing one
 * from memory is not a thing anyone does.
 */
function renderVariable(template: TemplateResourceModel, variable: string): HTMLLabelElement {
    const label = document.createElement('label');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = variable;
    label.append(name);

    const mark = document.createElement('span');
    mark.className = 'req';
    mark.textContent = ' *';
    label.append(mark);

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = template.uriTemplate;
    label.append(hint);

    const listId = `complete-${variable}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.name = variable;
    input.autocomplete = 'off';
    input.setAttribute('list', listId);

    const datalist = document.createElement('datalist');
    datalist.id = listId;

    input.addEventListener('input', () => {
        void complete(template.uriTemplate, variable, input.value, datalist);
    });

    label.append(input, datalist);
    return label;
}

async function complete(
    uriTemplate: string,
    variable: string,
    value: string,
    into: HTMLDataListElement,
): Promise<void> {
    const client = connection.client;
    if (client === undefined) {
        return;
    }
    try {
        const result = await client.complete({
            ref: { type: 'ref/resource', uri: uriTemplate },
            argument: { name: variable, value },
        });
        into.replaceChildren(
            ...result.completion.values.map((suggestion) => {
                const option = document.createElement('option');
                option.value = suggestion;
                return option;
            }),
        );
    } catch {
        // Suggestions are a convenience. A server that cannot produce them — or does not implement
        // completion at all — must not turn typing into an error message per keystroke.
        into.replaceChildren();
    }
}

resourceForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (selectedResource?.kind !== 'template') {
        return;
    }

    const values: Record<string, string> = {};
    for (const variable of selectedResource.template.variables) {
        const control = resourceForm.elements.namedItem(variable);
        values[variable] = control instanceof HTMLInputElement ? control.value : '';
    }

    const expanded = expandTemplate(selectedResource.template.uriTemplate, values);
    if (!expanded.ok) {
        showResourceBody(`Fill in: ${expanded.missing.join(', ')}. Nothing was read.`, 'failed');
        return;
    }
    void readResource(expanded.uri);
});

async function readResource(uri: string): Promise<void> {
    const client = connection.client;
    if (client === undefined) {
        showResourceBody('Not connected.', 'failed');
        return;
    }

    resourceButton.disabled = true;
    showResourceBody(`reading ${uri}…`);
    try {
        // 'bypass': this is a debugging tool, and a cached read would show what the server said
        // earlier rather than what it says now. The server sets no cache hint, so nothing is held
        // today — this makes the panel independent of that staying true.
        const result = await client.readResource({ uri }, { cacheMode: 'bypass' });
        showResourceBody(contentsToText(result.contents));
    } catch (error) {
        const failure = classifyReadFailure(error, uri);
        // A miss is the server working correctly. It reads as an absent resource, and the
        // connection badge stays exactly as green as it was.
        showResourceBody(
            failure.kind === 'not-found' ? `No resource at ${failure.uri}.` : failure.message,
            failure.kind,
        );
    } finally {
        resourceButton.disabled = false;
    }
}

function showResourceBody(text: string, state?: 'not-found' | 'failed'): void {
    resourceBody.textContent = text;
    resourceBody.dataset['error'] = state ?? 'false';
    resourceBody.hidden = false;
}

/* ---- prompts ------------------------------------------------------------------------------ */

function renderPrompts(error?: string): void {
    if (error !== undefined) {
        showPromptNote(error);
    } else if (!promptsLoaded) {
        showPromptNote('waiting for the connection…');
    } else if (prompts.length === 0) {
        showPromptNote('This server exposes no prompts.');
    } else {
        promptsNote.hidden = true;
    }

    promptList.replaceChildren();
    for (const prompt of prompts) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(prompt.name === selectedPrompt?.name));
        button.textContent = prompt.name;

        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.textContent = prompt.description;
        button.append(kind);

        button.addEventListener('click', () => selectPrompt(prompt));
        item.append(button);
        promptList.append(item);
    }
}

function showPromptNote(text: string): void {
    promptsNote.textContent = text;
    promptsNote.hidden = false;
}

function selectPrompt(prompt: PromptModel): void {
    selectedPrompt = prompt;
    promptMessages.hidden = true;
    promptFields.replaceChildren();
    for (const argument of prompt.args) {
        promptFields.append(renderPromptArgument(prompt, argument));
    }
    promptForm.hidden = false;
    renderPrompts();
}

/**
 * One text box per argument. Not a simplification — `prompts/list` carries a name, a description
 * and a required flag and nothing else, so there is no type to render a better control from.
 */
function renderPromptArgument(
    prompt: PromptModel,
    argument: PromptModel['args'][number],
): HTMLLabelElement {
    const label = document.createElement('label');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = argument.name;
    label.append(name);

    if (argument.required) {
        const mark = document.createElement('span');
        mark.className = 'req';
        mark.textContent = ' *';
        label.append(mark);
    }

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = argument.description;
    label.append(hint);

    const listId = `complete-prompt-${prompt.name}-${argument.name}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.name = argument.name;
    input.autocomplete = 'off';
    input.setAttribute('list', listId);

    const datalist = document.createElement('datalist');
    datalist.id = listId;

    input.addEventListener('input', () => {
        void completePromptArgument(prompt.name, argument.name, input.value, datalist);
    });

    label.append(input, datalist);
    return label;
}

async function completePromptArgument(
    promptName: string,
    argument: string,
    value: string,
    into: HTMLDataListElement,
): Promise<void> {
    const client = connection.client;
    if (client === undefined) {
        return;
    }
    try {
        const result = await client.complete({
            ref: { type: 'ref/prompt', name: promptName },
            argument: { name: argument, value },
        });
        into.replaceChildren(
            ...result.completion.values.map((suggestion) => {
                const option = document.createElement('option');
                option.value = suggestion;
                return option;
            }),
        );
    } catch {
        // An argument with no completer answers an empty list rather than an error, and a server
        // without completions at all should not produce a message per keystroke either.
        into.replaceChildren();
    }
}

promptForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (selectedPrompt === undefined) {
        return;
    }

    const values: Record<string, string> = {};
    for (const argument of selectedPrompt.args) {
        const control = promptForm.elements.namedItem(argument.name);
        values[argument.name] = control instanceof HTMLInputElement ? control.value : '';
    }

    const built = buildPromptArguments(selectedPrompt.args, values);
    if (!built.ok) {
        showPromptFailure(`Required and empty: ${built.missing.join(', ')}. Nothing was sent.`);
        return;
    }

    void getPrompt(selectedPrompt.name, built.args);
});

async function getPrompt(name: string, args: Record<string, string>): Promise<void> {
    const client = connection.client;
    if (client === undefined) {
        showPromptFailure('Not connected.');
        return;
    }

    promptButton.disabled = true;
    showPromptFailure(`getting ${name}…`);
    try {
        const result = await client.getPrompt({ name, arguments: args });
        renderBlocks(toRenderedBlocks(result.messages as { role?: string; content?: unknown }[]));
    } catch (error) {
        // A prompt whose argument named nothing fails as an argument error, not as a broken
        // connection: the server answered, and the fix is in the form.
        showPromptFailure(describe(error));
    } finally {
        promptButton.disabled = false;
    }
}

function renderBlocks(blocks: RenderedBlock[]): void {
    promptMessages.replaceChildren();
    for (const block of blocks) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block';
        wrapper.dataset['kind'] = block.kind;

        const who = document.createElement('div');
        who.className = 'who';
        who.textContent = block.role;
        if (block.uri !== undefined) {
            const uri = document.createElement('span');
            uri.className = 'uri';
            uri.textContent = block.uri;
            who.append(uri);
        }

        // textContent, never innerHTML: this is server-supplied text that embeds task data
        // written by whoever uses the api.
        const body = document.createElement('pre');
        body.className = 'result body';
        body.textContent = block.body;

        wrapper.append(who, body);
        promptMessages.append(wrapper);
    }
    promptMessages.hidden = false;
}

function showPromptFailure(text: string): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'block';
    wrapper.dataset['kind'] = 'unknown';
    const body = document.createElement('pre');
    body.className = 'result body';
    body.dataset['error'] = 'true';
    body.textContent = text;
    wrapper.append(body);
    promptMessages.replaceChildren(wrapper);
    promptMessages.hidden = false;
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
renderResources();
renderPrompts();
renderLog();
setStatus('connecting', 'negotiating…');
connection.connect().catch(() => {
    // The handler already put the reason on the page; this stops an unhandled rejection.
});
