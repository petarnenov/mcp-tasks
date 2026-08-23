/**
 * A tool's `inputSchema` turned into something a form can render, and a form's values turned back
 * into MCP tool arguments.
 *
 * No DOM. Everything here is a pure function over data, which is what lets it be tested in Node
 * with no browser — see the note in `main.ts` on why the DOM lives in exactly one file.
 *
 * This deliberately understands only the shapes the five tasks tools actually use: a flat object
 * of required and optional strings, some of them enums. A general JSON Schema renderer is a much
 * larger thing and would be mostly untested code. Anything it does not understand is reported
 * rather than silently dropped — see {@link FieldModel.kind} `'unsupported'`.
 */

/** The subset of JSON Schema this understands. Anything else lands in `unsupported`. */
export interface JsonSchema {
    type?: string;
    properties?: Record<string, JsonSchemaProperty | undefined>;
    required?: string[];
}

export interface JsonSchemaProperty {
    type?: string;
    description?: string;
    enum?: unknown[];
}

export type FieldModel =
    | { kind: 'text'; name: string; description: string; required: boolean }
    | { kind: 'enum'; name: string; description: string; required: boolean; options: string[] }
    /** A property whose shape this renderer does not know. Shown disabled, never guessed at. */
    | { kind: 'unsupported'; name: string; description: string; required: boolean; reason: string };

/**
 * Reads a tool's schema into an ordered list of fields.
 *
 * Order follows the schema's own property order, not `required` first. The schemas are written by
 * hand on the server with the arguments in the order a person would fill them in, and reordering
 * would lose that.
 */
export function toFormModel(schema: JsonSchema | undefined): FieldModel[] {
    const properties = schema?.properties ?? {};
    const required = new Set(schema?.required ?? []);

    return Object.entries(properties).map(([name, property]) => {
        const description = property?.description ?? '';
        const base = { name, description, required: required.has(name) };

        if (property?.enum !== undefined) {
            const options = property.enum.filter((value): value is string => typeof value === 'string');
            if (options.length !== property.enum.length) {
                return { ...base, kind: 'unsupported', reason: 'enum contains non-string values' };
            }
            return { ...base, kind: 'enum', options };
        }

        if (property?.type === 'string' || property?.type === undefined) {
            return { ...base, kind: 'text' };
        }

        return { ...base, kind: 'unsupported', reason: `unsupported type '${property.type}'` };
    });
}

/** What a filled-in form hands back: every field, including the ones left blank. */
export type FormValues = Record<string, string>;

export type BuildResult =
    | { ok: true; args: Record<string, unknown> }
    | { ok: false; missing: string[] };

/**
 * Turns raw form values into the arguments object for `tools/call`.
 *
 * **An empty optional field is omitted, not sent as `""`.** This is the single most consequential
 * line in this module. `tasks_update` is a full replace: the server resets any field it does not
 * receive, but an empty string is a value, so sending one would set a task's title to blank rather
 * than leaving it alone. A form that "helpfully" sends every input would quietly corrupt data.
 * See vault/specs/mcp-client.md obligation 6, and [[task-api]] obligation 14 behind it.
 *
 * A required field left blank is refused here rather than sent for the server to reject — the
 * round trip tells the person nothing they could not be told immediately.
 */
export function buildArguments(fields: FieldModel[], values: FormValues): BuildResult {
    const missing = fields
        .filter((field) => field.required && (values[field.name] ?? '').trim() === '')
        .map((field) => field.name);

    if (missing.length > 0) {
        return { ok: false, missing };
    }

    const args: Record<string, unknown> = {};
    for (const field of fields) {
        const value = values[field.name] ?? '';
        // Blank optional -> absent. Never `""`, never `null`.
        if (value === '') {
            continue;
        }
        args[field.name] = value;
    }
    return { ok: true, args };
}
