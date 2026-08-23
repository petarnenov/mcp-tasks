/**
 * The message log's data model.
 *
 * No DOM — `main.ts` renders whatever this holds.
 *
 * The log is built by watching `fetch`, not by asking the SDK: the client exposes no message hook,
 * and the transport takes a `fetch` we can supply. That has a consequence worth knowing, because
 * it is the difference between this log and a wrong one:
 *
 * A modern MCP exchange is one POST per request, **except** `subscriptions/listen`, whose response
 * is a stream that stays open for the life of the connection. Its `fetch` resolves as soon as the
 * headers arrive, but the exchange is not finished — it is *listening*. An entry for it must read
 * as an open stream, never as a request that took 4ms and never as one stuck pending. That is
 * {@link ExchangeState} `'streaming'`, and vault/specs/mcp-client.md obligation 11.
 *
 * The 2025 era has the same trap in a different shape, found on 2026-08-23 by pointing this client
 * at a real 1.x server: there the notification channel is a body-less **GET** on the endpoint,
 * which `subscriptions/listen` replaced. It is equally long-lived and was equally mislabelled
 * `complete 2ms`. Both are handled by {@link describeRequest}, which is why the streaming decision
 * lives there rather than in a list of method names.
 */

export type ExchangeState =
    /** The POST is in flight. */
    | 'pending'
    /** Answered, and that is the whole exchange. */
    | 'complete'
    /** Answered with a stream that stays open. Not pending, not finished. */
    | 'streaming'
    /** The request never reached the server, or the server answered non-2xx. */
    | 'failed';

export interface Exchange {
    readonly id: number;
    /** JSON-RPC method from the request body, or a label for a request that carries none. */
    readonly method: string;
    /** True when this request opens a channel that stays open rather than awaiting one answer. */
    readonly streaming: boolean;
    readonly direction: 'client -> server';
    state: ExchangeState;
    /** Milliseconds to the response headers. Undefined while pending. */
    durationMs?: number;
    /** Set when `state` is `'failed'`. */
    detail?: string;
}

/** Modern-era methods whose response is a long-lived stream rather than a single answer. */
const STREAMING_METHODS = new Set(['subscriptions/listen']);

/** What one HTTP request to the MCP endpoint is, for the purpose of logging it. */
export interface RequestShape {
    label: string;
    /** True when the response is a channel that stays open, not an answer that arrives. */
    streaming: boolean;
}

/**
 * Reads an outgoing request into a log label and whether it opens a stream.
 *
 * Takes the HTTP method as well as the body, because the body alone cannot tell a 2025-era
 * notification stream (`GET`, no body) from a session teardown (`DELETE`, no body) — and one of
 * those stays open while the other does not.
 */
export function describeRequest(httpMethod: string | undefined, body: unknown): RequestShape {
    const verb = (httpMethod ?? 'GET').toUpperCase();

    if (typeof body !== 'string' || body === '') {
        if (verb === 'GET') {
            return { label: 'GET (notification stream)', streaming: true };
        }
        if (verb === 'DELETE') {
            return { label: 'DELETE (end session)', streaming: false };
        }
        return { label: `${verb} (no body)`, streaming: false };
    }

    const label = methodOf(body);
    return { label, streaming: STREAMING_METHODS.has(label) };
}

export class MessageLog {
    #entries: Exchange[] = [];
    #nextId = 1;
    #onChange: () => void;

    constructor(onChange: () => void = () => {}) {
        this.#onChange = onChange;
    }

    /** Newest first, matching the order a person reads a log while debugging. */
    entries(): readonly Exchange[] {
        return [...this.#entries].reverse();
    }

    clear(): void {
        this.#entries = [];
        this.#onChange();
    }

    started(shape: RequestShape): Exchange {
        const exchange: Exchange = {
            id: this.#nextId++,
            method: shape.label,
            streaming: shape.streaming,
            direction: 'client -> server',
            state: 'pending',
        };
        this.#entries.push(exchange);
        this.#onChange();
        return exchange;
    }

    answered(exchange: Exchange, durationMs: number, ok: boolean, detail?: string): void {
        exchange.durationMs = Math.round(durationMs);
        if (!ok) {
            exchange.state = 'failed';
            exchange.detail = detail;
        } else {
            exchange.state = exchange.streaming ? 'streaming' : 'complete';
        }
        this.#onChange();
    }

    failed(exchange: Exchange, detail: string): void {
        exchange.state = 'failed';
        exchange.detail = detail;
        this.#onChange();
    }
}

/** Reads the JSON-RPC method out of a request body, for labelling a log entry. */
export function methodOf(body: unknown): string {
    if (typeof body !== 'string') {
        return '(no body)';
    }
    try {
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed)) {
            // A JSON-RPC batch. Naming the first method is more use than "(batch)".
            const first: unknown = parsed[0];
            return `${methodIn(first) ?? '(batch)'} +${parsed.length - 1}`;
        }
        return methodIn(parsed) ?? '(response)';
    } catch {
        return '(unparsed)';
    }
}

function methodIn(message: unknown): string | undefined {
    if (typeof message === 'object' && message !== null && 'method' in message) {
        const method = (message as { method: unknown }).method;
        if (typeof method === 'string') {
            return method;
        }
    }
    return undefined;
}
