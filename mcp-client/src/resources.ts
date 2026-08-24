/**
 * What the server offers to read, turned into something a panel can render — and the errors of
 * reading it, classified.
 *
 * No DOM, same rule and same reason as `schema-form.ts`: everything here is a pure function over
 * data, so it is tested in Node with no browser.
 *
 * The one thing worth stating up front is the error classification. A resource read has no
 * `isError` arm the way a tool call does; a miss arrives as a JSON-RPC error, which is the same
 * channel a broken connection arrives on. Telling the two apart is what keeps "there is no task
 * with that id" from being rendered as "the client is broken" — see {@link classifyReadFailure}.
 */

import { ResourceNotFoundError, UriTemplate } from '@modelcontextprotocol/client';

/** A resource with a fixed URI: one click to read. */
export interface StaticResourceModel {
    name: string;
    uri: string;
    description: string;
    mimeType: string;
}

/** A resource template: variables to fill in, then read. */
export interface TemplateResourceModel {
    name: string;
    uriTemplate: string;
    description: string;
    mimeType: string;
    /** The variables the URI template asks for, in the order it names them. */
    variables: string[];
}

export interface ResourcesModel {
    resources: StaticResourceModel[];
    templates: TemplateResourceModel[];
}

/** The empty model. What a server with no resource capability produces, and the initial state. */
export const NO_RESOURCES: ResourcesModel = { resources: [], templates: [] };

/** The wire shapes this reads. Narrower than the SDK's, and only what the panel renders. */
interface WireResource {
    name?: string;
    uri: string;
    description?: string;
    mimeType?: string;
}

interface WireTemplate {
    name?: string;
    uriTemplate: string;
    description?: string;
    mimeType?: string;
}

/**
 * The part of an MCP `Client` this module needs, and nothing else.
 *
 * Structural on purpose: the real `Client` satisfies it, and so does a counter in a test — which is
 * what makes "asks for nothing when the server declares no resources" an assertion rather than a
 * claim about a private method.
 */
export interface ResourceReader {
    getServerCapabilities(): { resources?: unknown } | undefined;
    listResources(): Promise<{ resources: WireResource[] }>;
    listResourceTemplates(): Promise<{ resourceTemplates: WireTemplate[] }>;
}

export interface LoadResult {
    model: ResourcesModel;
    /** Set when the listing failed. Belongs in the panel, not in the connection status. */
    error?: string;
}

/**
 * What the server offers to read, or nothing.
 *
 * The capability is checked first and **no request is made without it**. Negotiation in this client
 * is `'auto'` and this is a debugging tool: pointed at a server with no resources — including our
 * own, before they shipped — it must render an empty panel rather than throw `-32601` at a server
 * that is behaving correctly.
 *
 * A failure of the listing itself is returned rather than thrown. The connection is up and the
 * tools are callable; the only thing that broke is this panel.
 */
export async function loadResources(client: ResourceReader): Promise<LoadResult> {
    if (client.getServerCapabilities()?.resources === undefined) {
        return { model: NO_RESOURCES };
    }
    try {
        const [resources, templates] = await Promise.all([
            client.listResources(),
            client.listResourceTemplates(),
        ]);
        return { model: toResourcesModel(resources.resources, templates.resourceTemplates) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { model: NO_RESOURCES, error: `Listing resources failed: ${message}` };
    }
}

export function toResourcesModel(resources: WireResource[], templates: WireTemplate[]): ResourcesModel {
    return {
        resources: resources.map((resource) => ({
            name: resource.name ?? resource.uri,
            uri: resource.uri,
            description: resource.description ?? '',
            mimeType: resource.mimeType ?? '',
        })),
        templates: templates.map((template) => ({
            name: template.name ?? template.uriTemplate,
            uriTemplate: template.uriTemplate,
            description: template.description ?? '',
            mimeType: template.mimeType ?? '',
            variables: variablesOf(template.uriTemplate),
        })),
    };
}

/**
 * The variables a template asks for.
 *
 * Parsed by the SDK's own `UriTemplate` rather than by a regex here: it is the same class the
 * server matched the URI with, so the two cannot drift over what counts as a variable. A template
 * this client cannot parse yields no variables and is rendered as unfillable rather than guessed
 * at.
 */
export function variablesOf(uriTemplate: string): string[] {
    try {
        return new UriTemplate(uriTemplate).variableNames;
    } catch {
        return [];
    }
}

export type ExpandResult =
    | { ok: true; uri: string }
    | { ok: false; missing: string[] };

/**
 * Fills a template in.
 *
 * A blank variable is refused here rather than expanded into an empty segment: `tasks://tasks/`
 * would be a read of something that does not exist, and the error it comes back with would blame
 * the server for a field the person simply had not filled in. Encoding is `UriTemplate`'s job.
 */
export function expandTemplate(uriTemplate: string, values: Record<string, string>): ExpandResult {
    const missing = variablesOf(uriTemplate).filter((name) => (values[name] ?? '').trim() === '');
    if (missing.length > 0) {
        return { ok: false, missing };
    }
    return { ok: true, uri: new UriTemplate(uriTemplate).expand(values) };
}

export type ReadFailure =
    /** The server answered, and there is nothing at that URI. The connection is fine. */
    | { kind: 'not-found'; uri: string; message: string }
    /** Anything else: the api behind the server, a transport failure, a protocol error. */
    | { kind: 'failed'; message: string };

/**
 * Which of the two failures this is.
 *
 * `ResourceNotFoundError` is re-exported by the client SDK and its `instanceof` is brand-matched
 * across separately bundled copies, so the check works even when the error was constructed by a
 * different copy of the SDK than the one this bundle holds.
 *
 * The fallback is the shape the SDK documents for recognising the same thing by hand: a `-32602`
 * (or, from an older peer, `-32002`) whose `data` carries a `uri`. A `-32602` without one is an
 * ordinary Invalid Params and stays `'failed'` — it means the request was wrong, not that the
 * resource is absent.
 */
export function classifyReadFailure(error: unknown, requestedUri: string): ReadFailure {
    const message = error instanceof Error ? error.message : String(error);

    if (ResourceNotFoundError.isInstance(error)) {
        return { kind: 'not-found', uri: error.uri, message };
    }

    const code = (error as { code?: unknown } | null)?.code;
    const data = (error as { data?: unknown } | null)?.data;
    if ((code === -32602 || code === -32002) && typeof data === 'object' && data !== null) {
        const uri = (data as { uri?: unknown }).uri;
        if (typeof uri === 'string') {
            return { kind: 'not-found', uri, message };
        }
    }

    return { kind: 'failed', message: `Reading ${requestedUri} failed: ${message}` };
}

/** The text of a read, the way the panel shows it. */
export function contentsToText(contents: { text?: string; blob?: string; mimeType?: string }[]): string {
    if (contents.length === 0) {
        return '(the server returned no contents)';
    }
    return contents
        .map((content) => {
            if (typeof content.text === 'string') {
                return content.text;
            }
            // Binary is a non-goal, so say what it is rather than rendering base64 as if it were
            // the document.
            return `(${content.mimeType ?? 'binary'} content, ${content.blob?.length ?? 0} base64 chars — not shown)`;
        })
        .join('\n');
}
