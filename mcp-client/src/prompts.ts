/**
 * What the server offers as starting points, turned into something a panel can render — and the
 * messages it returns, flattened for display.
 *
 * No DOM, same rule and reason as `schema-form.ts` and `resources.ts`.
 *
 * The shape of the argument form is not a choice made here. A prompt argument arrives with a name,
 * a description and a required flag, and **nothing else** — no type, no enum, no default, because
 * that is all `prompts/list` carries. Every argument is therefore a text box, and the description
 * is the only guidance a person gets. See vault/specs/mcp-prompts.md, "Arguments are strings".
 */

/** The wire shapes this reads. Narrower than the SDK's, and only what the panel renders. */
interface WirePrompt {
    name: string;
    title?: string;
    description?: string;
    arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface PromptArgumentModel {
    name: string;
    description: string;
    required: boolean;
}

export interface PromptModel {
    name: string;
    title: string;
    description: string;
    args: PromptArgumentModel[];
}

/** The empty model. What a server with no prompt capability produces, and the initial state. */
export const NO_PROMPTS: PromptModel[] = [];

/**
 * The part of an MCP `Client` this module needs.
 *
 * Structural, so a call-counting stand-in satisfies it too — which is what makes "asks for nothing
 * when the server declares no prompts" an assertion rather than a claim.
 */
export interface PromptReader {
    getServerCapabilities(): { prompts?: unknown } | undefined;
    listPrompts(): Promise<{ prompts: WirePrompt[] }>;
}

export interface LoadPromptsResult {
    prompts: PromptModel[];
    /** Set when the listing failed. Belongs in the panel, not in the connection status. */
    error?: string;
}

/**
 * What the server offers as prompts, or nothing.
 *
 * The capability is checked first and **no request is made without it** — this client is a
 * debugging tool pointed at whatever is on the other end, and a `-32601` thrown at a server with
 * no prompts would be the client misbehaving, not the server.
 */
export async function loadPrompts(client: PromptReader): Promise<LoadPromptsResult> {
    if (client.getServerCapabilities()?.prompts === undefined) {
        return { prompts: NO_PROMPTS };
    }
    try {
        const result = await client.listPrompts();
        return { prompts: toPromptModels(result.prompts) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { prompts: NO_PROMPTS, error: `Listing prompts failed: ${message}` };
    }
}

export function toPromptModels(prompts: WirePrompt[]): PromptModel[] {
    return prompts.map((prompt) => ({
        name: prompt.name,
        title: prompt.title ?? prompt.name,
        description: prompt.description ?? '',
        args: (prompt.arguments ?? []).map((argument) => ({
            name: argument.name,
            description: argument.description ?? '',
            required: argument.required ?? false,
        })),
    }));
}

export type BuildArgumentsResult =
    | { ok: true; args: Record<string, string> }
    | { ok: false; missing: string[] };

/**
 * Turns filled-in form values into the `arguments` object `prompts/get` expects.
 *
 * A required argument left blank is refused here rather than sent for the server to reject: the
 * round trip tells the person nothing they could not be told immediately, and the server's message
 * is a schema error rather than a sentence about their form.
 *
 * A blank optional argument is omitted rather than sent as `""`, the same rule `schema-form.ts`
 * follows — an empty string is a value, and a prompt cannot tell it apart from a deliberate one.
 */
export function buildPromptArguments(
    args: PromptArgumentModel[],
    values: Record<string, string>,
): BuildArgumentsResult {
    const missing = args
        .filter((argument) => argument.required && (values[argument.name] ?? '').trim() === '')
        .map((argument) => argument.name);

    if (missing.length > 0) {
        return { ok: false, missing };
    }

    const built: Record<string, string> = {};
    for (const argument of args) {
        const value = values[argument.name] ?? '';
        if (value === '') {
            continue;
        }
        built[argument.name] = value;
    }
    return { ok: true, args: built };
}

/** One message block, ready to render. */
export interface RenderedBlock {
    role: string;
    kind: 'text' | 'resource' | 'resource-link' | 'unknown';
    /** The URI, for the two resource kinds. */
    uri?: string;
    /** The text to show: the message, the embedded body, or a description of what was sent. */
    body: string;
}

/**
 * Flattens `prompts/get` into blocks a panel can print.
 *
 * An unrecognised content type is **reported**, never dropped. A client that silently discards what
 * it does not understand is a client that lies about what the server sent — and this one exists to
 * show what the server sent.
 */
export function toRenderedBlocks(
    messages: { role?: string; content?: unknown }[],
): RenderedBlock[] {
    return messages.map((message) => {
        const role = message.role ?? 'user';
        const content = (message.content ?? {}) as Record<string, unknown>;
        const type = content['type'];

        if (type === 'text') {
            return { role, kind: 'text', body: String(content['text'] ?? '') };
        }

        if (type === 'resource') {
            const resource = (content['resource'] ?? {}) as Record<string, unknown>;
            const uri = typeof resource['uri'] === 'string' ? resource['uri'] : '(no uri)';
            if (typeof resource['text'] === 'string') {
                return { role, kind: 'resource', uri, body: resource['text'] };
            }
            // Binary is a non-goal here too: say what it is rather than printing base64.
            const mime = typeof resource['mimeType'] === 'string' ? resource['mimeType'] : 'binary';
            return { role, kind: 'resource', uri, body: `(${mime} content — not shown)` };
        }

        if (type === 'resource_link') {
            const uri = typeof content['uri'] === 'string' ? content['uri'] : '(no uri)';
            return {
                role,
                kind: 'resource-link',
                uri,
                body: 'A link, not a copy. Read it in the Resources panel.',
            };
        }

        return { role, kind: 'unknown', body: `(unrenderable content of type '${String(type)}')` };
    });
}
