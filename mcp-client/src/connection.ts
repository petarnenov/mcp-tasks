/**
 * Building and holding the MCP connection.
 *
 * No DOM — callers pass in the handlers they want and render the results themselves.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { describeRequest, MessageLog } from './log.js';
import { loadPrompts, type PromptModel } from './prompts.js';
import { loadResources, type ResourcesModel } from './resources.js';

/** The revision this client prefers, and the one it reports having failed to get. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * Negotiation mode: `'auto'`.
 *
 * `connect()` probes `server/discover` first and takes the modern era when the server offers it,
 * falling back to the 2025 `initialize` handshake otherwise. Chosen over `{ pin }` on 2026-08-23.
 *
 * Two reasons, and the second is the one measured:
 *
 * 1. A pinned client cannot talk to a 2025-era server at all, which makes it useless as a
 *    debugging tool the moment it is pointed at anything but this repository's own server.
 * 2. Pinning does not even fail *fast*. Against a stand-in server that refuses `server/discover`
 *    the way the old Java implementation did, a pinned connect sat for the full 60-second probe
 *    timeout before rejecting — on HTTP the SDK treats silence as an outage rather than a legacy
 *    signal, so it retries rather than concluding. `'auto'` concludes and falls back.
 *
 * **The cost, and what is done about it.** `'auto'` is exactly the setting that let the MCP
 * Inspector show LEGACY against a server that serves 2026-07-28 without anyone noticing, which is
 * what started this whole line of work. A silent downgrade is the failure mode to avoid, so this
 * client never downgrades silently: {@link Connection} reports the negotiated era to the page, and
 * anything other than modern is rendered as a warning rather than as a normal connection. Auto for
 * reach, loud for honesty.
 */
export const NEGOTIATION_MODE = 'auto';

/**
 * The MCP endpoint, relative on purpose.
 *
 * The page is served from `/mcp/client` and the endpoint is `/mcp` on the same nginx listener, so
 * this resolves to the same origin: no CORS, no preflight, and the modern era's custom
 * `MCP-Protocol-Version` and `Mcp-Method` headers travel without a preflight to allow them.
 *
 * Relative rather than absolute so `PORT=9000 make up` needs no rebuild — whatever port served the
 * page serves the endpoint.
 */
export const MCP_PATH = '/mcp';

export interface Tool {
    name: string;
    description?: string;
    inputSchema?: unknown;
}

export interface Connected {
    name: string;
    version: string;
    /** The revision actually negotiated, e.g. `2026-07-28` or `2025-11-25`. */
    protocol: string;
    /** `'modern'` for the 2026-07-28 era, `'legacy'` for the 2025 handshake. */
    era: string;
    /** True when the server did NOT give us the modern era. The page must not hide this. */
    downgraded: boolean;
}

export interface ConnectionHandlers {
    /** Called whenever the tool list changes, including the first load. */
    onTools: (tools: Tool[]) => void;
    /**
     * Called once after connecting, with what the server offers to read.
     *
     * There is no list-change counterpart: this server declares `resources.listChanged: false`
     * because it builds one instance per request and has nothing to notify from. A client that
     * subscribed anyway would hold a stream open for refreshes that cannot arrive.
     *
     * `error` is set when the listing itself failed. It belongs in the panel rather than in the
     * status badge: the connection is up and the tools are callable, and reddening the badge for
     * this would misreport the state of everything else on the page.
     */
    onResources: (resources: ResourcesModel, error?: string) => void;
    /**
     * Called once after connecting, with the prompts the server offers.
     *
     * Same shape as `onResources`, and for the same reasons — including `error`, which belongs in
     * the panel rather than in the status badge.
     */
    onPrompts: (prompts: PromptModel[], error?: string) => void;
    /** Called when the connection is established, with what was actually negotiated. */
    onConnected: (connected: Connected) => void;
    onError: (message: string) => void;
}

export class Connection {
    readonly log: MessageLog;
    #client?: Client;
    #handlers: ConnectionHandlers;

    constructor(log: MessageLog, handlers: ConnectionHandlers) {
        this.log = log;
        this.#handlers = handlers;
    }

    get client(): Client | undefined {
        return this.#client;
    }

    async connect(): Promise<void> {
        const client = new Client(
            { name: 'tasks-mcp-client', version: '0.1.0' },
            {
                versionNegotiation: { mode: NEGOTIATION_MODE },
                // Opting in is what makes the server's tools.listChanged capability mean anything
                // here: the SDK opens a `subscriptions/listen` stream and re-fetches on its own.
                // It is also what puts a genuine open stream in the log — see log.ts.
                listChanged: {
                    tools: {
                        onChanged: (error, tools) => {
                            if (error) {
                                this.#handlers.onError(`Refreshing the tool list failed: ${describe(error)}`);
                                return;
                            }
                            this.#handlers.onTools((tools ?? []) as Tool[]);
                        },
                    },
                },
            },
        );

        const url = new URL(MCP_PATH, window.location.origin);
        const transport = new StreamableHTTPClientTransport(url, { fetch: this.#instrumentedFetch() });

        try {
            await client.connect(transport);
        } catch (error) {
            this.#handlers.onError(`Could not connect: ${describe(error)}`);
            throw error;
        }

        this.#client = client;
        const info = client.getServerVersion();
        const protocol = client.getNegotiatedProtocolVersion() ?? 'unknown';
        const era = client.getProtocolEra() ?? 'unknown';
        this.#handlers.onConnected({
            name: info?.name ?? '(unnamed)',
            version: info?.version ?? '(no version)',
            protocol,
            era,
            // Anything but the modern era is a downgrade the page has to show. Under `'auto'` this
            // is the only thing standing between a working connection and the silent LEGACY that
            // started this work.
            downgraded: era !== 'modern',
        });

        const { tools } = await client.listTools();
        this.#handlers.onTools(tools as Tool[]);

        // The capability checks and the failure handling live in `resources.ts` and `prompts.ts`
        // -- pure, and so testable without a browser or a server. A listing failure comes back as
        // `error` rather than through `onError`: it goes to its own panel, not to the status
        // badge, because the connection is up and every tool is still callable.
        const [resources, prompts] = await Promise.all([loadResources(client), loadPrompts(client)]);
        this.#handlers.onResources(resources.model, resources.error);
        this.#handlers.onPrompts(prompts.prompts, prompts.error);
    }

    /**
     * Wraps `fetch` so every exchange lands in the log.
     *
     * The SDK exposes no message hook, but the transport takes a `fetch`. This is the seam.
     */
    #instrumentedFetch(): typeof fetch {
        return async (input, init) => {
            const exchange = this.log.started(describeRequest(init?.method, init?.body));
            const startedAt = performance.now();
            try {
                const response = await fetch(input, init);
                this.log.answered(
                    exchange,
                    performance.now() - startedAt,
                    response.ok,
                    response.ok ? undefined : `HTTP ${response.status}`,
                );
                return response;
            } catch (error) {
                this.log.failed(exchange, describe(error));
                throw error;
            }
        };
    }
}

export function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
