/**
 * The task list exposed as MCP resources.
 *
 * Two of them: the collection at `tasks://tasks`, and one task at `tasks://tasks/{id}`. They
 * return the same JSON the tools do, on purpose -- a resource read and a `tasks_get` should be
 * byte-identical, so a difference in the text is never a formatting difference.
 *
 * **This file throws. `tools.ts`, next door, says never to.** Both are right, and the difference is
 * in the SDK's types rather than in taste: a tool result has an `isError` arm to put a readable
 * message in, and `ReadResourceResult` has none. The only way to report "no such task" from a
 * resource read is a JSON-RPC error. Answering 200 with `{"error": ...}` in the body would be
 * worse than throwing -- a client caches it as content and a model reads a task that says
 * "not found".
 *
 * What is thrown matters too:
 *
 * - `ResourceNotFoundError` crosses the wire as `-32602` with `data: { uri }` on BOTH eras. The SDK
 *   never emits `-32002`; a handler-thrown one is remapped at the era encode seam, because the
 *   2026-07-28 spec says MUST.
 * - `ProtocolError` carries its message to the client. A bare `Error` does not -- that is the
 *   opaque `-32603` that `tools.ts`'s first implementation note is about.
 *
 * Read-only, and it stays read-only: nothing that writes ever gets a URI here. See
 * vault/specs/mcp-resources.md, "Why this duplicates two tools".
 */

import {
    ProtocolError,
    ProtocolErrorCode,
    ResourceNotFoundError,
    ResourceTemplate,
    type McpServer,
    type ReadResourceResult,
} from '@modelcontextprotocol/server';

import type { ApiResult, TasksClient } from './tasks-client.js';

/** The collection. Static URI, so the SDK answers it by exact string match before any template. */
export const TASKS_URI = 'tasks://tasks';

/**
 * One task, by id.
 *
 * A custom scheme rather than `http://`: these are not fetchable URLs and an `http` one invites a
 * client to try. The member sits under the collection so the relationship needs no explaining.
 *
 * The shape was checked against the SDK's lookup rather than assumed. `resources/read` builds a
 * `new URL(...)` and looks the *string* up among the static resources before trying any template,
 * so a URI that normalised -- a trailing slash appearing, a case change -- would leave a resource
 * unreachable. `tasks://tasks` and `tasks://tasks/{id}` both round-trip through `URL` unchanged,
 * and ids live in the path, which `URL` leaves alone. Only the host is lowercased, and ours is the
 * constant `tasks`.
 */
export const TASK_URI_TEMPLATE = 'tasks://tasks/{id}';

const JSON_MIME = 'application/json';

export function registerTaskResources(server: McpServer, tasks: TasksClient): void {
    server.registerResource(
        'tasks',
        TASKS_URI,
        {
            title: 'All tasks',
            description:
                'Every task, as a JSON array. The same data tasks_list returns, as material to read '
                + 'rather than an action to take.',
            mimeType: JSON_MIME,
        },
        // No cacheHint, here or below. The 2026-07-28 default is ttlMs 0 / private -- nothing is
        // held -- and that is what this data deserves: tasks are mutable by anyone with the api,
        // this server cannot know when, and a stale task is a failure a model has no way to
        // detect. A round trip we can afford is not worth trading for it.
        async (uri) => contents(uri, await tasks.list()),
    );

    server.registerResource(
        'task',
        new ResourceTemplate(TASK_URI_TEMPLATE, {
            // `undefined`, not an enumeration of every task, and the SDK makes you write the key
            // out so the choice is deliberate.
            //
            // Listing them would put a GET /tasks -- and an api outage -- inside `resources/list`,
            // whose handler awaits this callback and has no failure arm. An api that was down
            // would then take out the listing of the collection too, which is the one thing still
            // worth having in that state. Nothing becomes undiscoverable: `tasks://tasks` IS the
            // list of ids, one read away, and this template is advertised through
            // `resources/templates/list` with completion on `id`.
            list: undefined,
            complete: {
                /**
                 * Ids starting with what has been typed.
                 *
                 * Returns [] on any api failure and never throws: completion fires on keystrokes,
                 * and an outage should degrade to no suggestions rather than to an error per
                 * character. No slicing or `hasMore` bookkeeping either -- the SDK caps at 100 and
                 * computes that itself.
                 */
                id: async (value) => {
                    const result = await tasks.list();
                    if (!result.ok) {
                        return [];
                    }
                    return result.value.map((task) => task.id).filter((id) => id.startsWith(value));
                },
            },
        }),
        {
            title: 'Task by id',
            description: 'A single task as JSON, by the UUID that tasks_list and tasks://tasks return.',
            mimeType: JSON_MIME,
        },
        async (uri, { id }) => contents(uri, await tasks.get(single(id))),
    );
}

/**
 * A template variable is `string | string[]` -- the SDK's `Variables` allows the exploded form for
 * templates that ask for it. `{id}` never produces an array, but the type says it could, and
 * picking the first element is the only reading that is not a lie.
 */
function single(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return value[0] ?? '';
    }
    return value ?? '';
}

function contents<T>(uri: URL, result: ApiResult<T>): ReadResourceResult {
    if (!result.ok) {
        throw failure(uri, result);
    }
    return {
        contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(result.value, null, 2) }],
    };
}

function failure(uri: URL, result: Extract<ApiResult<never>, { ok: false }>): Error {
    if (result.kind === 'unreachable') {
        return new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Could not reach the task API: ${result.detail}. This is not something the arguments `
            + 'can fix; the service may be down.',
        );
    }
    if (result.status === 404) {
        return new ResourceNotFoundError(uri.href);
    }
    return new ProtocolError(
        ProtocolErrorCode.InternalError,
        `The task API returned HTTP ${result.status}. This is not something the arguments can fix; `
        + 'the service may be down.',
    );
}
