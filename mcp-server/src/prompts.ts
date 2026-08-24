/**
 * The task list as MCP prompts: named starting points, with the data already in them.
 *
 * Two of them. `triage_tasks` embeds `tasks://tasks` and asks what is in the wrong state;
 * `plan_task` embeds one task and asks for the steps to finish it. Both hand over the same bytes
 * `resources/read` would return, so the model sees one version of the data whichever door it came
 * through.
 *
 * **Three files, three error conventions, and they are not interchangeable.** `tools.ts` never
 * throws, because a tool result has an `isError` arm to put a readable message in. `resources.ts`
 * always throws `ResourceNotFoundError` for a miss. This file throws too -- `GetPromptResult` has
 * no error arm either -- but **never** `ResourceNotFoundError`: see {@link failure}.
 *
 * Nothing here writes, and the instruction text says so out loud. See
 * vault/specs/mcp-prompts.md, "Prompts share a connection with tools that write".
 */

import {
    completable,
    ProtocolError,
    ProtocolErrorCode,
    UriTemplate,
    type GetPromptResult,
    type McpServer,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import { TASK_URI_TEMPLATE, TASKS_URI } from './resources.js';
import type { ApiResult, TasksClient } from './tasks-client.js';

const JSON_MIME = 'application/json';

/**
 * The triage instruction.
 *
 * A named constant so that a change to what this server tells a model is visible as a change to
 * this string, rather than buried in a call.
 *
 * Two clauses are load-bearing and must not be trimmed:
 *
 * - **"Do not change anything."** The same connection carries `tasks_update` and `tasks_delete`.
 *   Text that reads as an instruction to act will be acted on; that is what the model is for.
 * - **The full-replace warning.** [[task-api]] obligation 14: a caller who thinks they are only
 *   editing the title wipes description, status and priority. Saying it here is what stops the
 *   data loss, rather than explaining it afterwards.
 */
export const TRIAGE_INSTRUCTION =
    'Below is the current task list from the tasks server, as JSON.\n\n'
    + 'Triage it. First, name every task that is in the wrong state and say which field should '
    + 'change and to what: status is one of TODO, IN_PROGRESS, DONE; priority is one of LOW, '
    + 'MEDIUM, HIGH. Then give the three tasks worth doing next, in order, one line of reasoning '
    + 'each.\n\n'
    + 'Do not change anything. Name the call that would make each change instead — and note that '
    + 'tasks_update is a full replace, so it must be given every field of the task, not only the '
    + 'one being changed. If the list is empty, or nothing needs changing, say so plainly rather '
    + 'than inventing work.';

/**
 * The planning instruction. Same rule as above: **"Do not create anything."** stays.
 *
 * `tasks_create` is one call away, and a plan is not a request to execute it.
 */
export const PLAN_INSTRUCTION =
    'Below is one task from the tasks server, as JSON.\n\n'
    + 'Break it down into the concrete steps needed to finish it, in the order they should happen. '
    + 'Keep it to the work this task actually names; if the description is empty or too vague to '
    + 'plan from, say what is missing rather than inventing requirements.\n\n'
    + 'Do not create anything. This is for thinking, not for writing tasks.';

export function registerTaskPrompts(server: McpServer, tasks: TasksClient): void {
    server.registerPrompt(
        'triage_tasks',
        {
            title: 'Triage the task list',
            description:
                'Look at every task and say which are in the wrong state, then what to do next. '
                + 'Reads only — it proposes changes rather than making them.',
        },
        async () => {
            const result = await tasks.list();
            return embed(TRIAGE_INSTRUCTION, TASKS_URI, result, 'Triage of the whole task list.');
        },
    );

    server.registerPrompt(
        'plan_task',
        {
            title: 'Plan one task',
            description: 'Break a single task down into the steps needed to finish it. Reads only.',
            argsSchema: z.object({
                id: completable(
                    z
                        .string()
                        // `.min(1)` is not decoration. A bare z.string() accepts "", which reaches
                        // the api as `GET /tasks/` -- and Micronaut answers that with the WHOLE
                        // LIST, 200. The prompt would then embed every task under the URI
                        // `tasks://tasks/` beneath an instruction to plan "this one task": a wrong
                        // answer with no error anywhere. Caught live on 2026-08-24.
                        .min(1, 'id must not be empty')
                        .describe("The task's UUID, as returned by tasks_list or the tasks://tasks resource"),
                    // [] on any failure, never a throw: completion fires per keystroke, and an
                    // outage should cost the suggestions rather than produce an error per
                    // character. The SDK caps at 100 and computes hasMore, so no slicing here.
                    async (value) => {
                        const result = await tasks.list();
                        if (!result.ok) {
                            return [];
                        }
                        return result.value.map((task) => task.id).filter((id) => id.startsWith(value));
                    },
                ),
            }),
        },
        async ({ id }) => {
            // Expanded through the SDK's own UriTemplate rather than by concatenation, so the URI
            // embedded here is exactly the one a client would pass to resources/read.
            const uri = new UriTemplate(TASK_URI_TEMPLATE).expand({ id });
            const result = await tasks.get(id);
            return embed(PLAN_INSTRUCTION, uri, result, `Plan for task ${id}.`, id);
        },
    );
}

/**
 * An instruction message, then the data as an embedded resource.
 *
 * Embedded rather than a `resource_link`: a link is only material if the client follows it, and
 * many do not — the prompt would arrive as an instruction about data the model cannot see. The URI
 * travels with the copy, so a client that wants to re-read has the address.
 *
 * The JSON formatting duplicates `resources.ts` deliberately. One `JSON.stringify` line repeated
 * is a better trade than coupling two primitives, and a test asserts the two agree byte for byte.
 */
function embed<T>(
    instruction: string,
    uri: string,
    result: ApiResult<T>,
    description: string,
    notFoundId?: string,
): GetPromptResult {
    if (!result.ok) {
        throw failure(result, notFoundId);
    }
    return {
        description,
        messages: [
            { role: 'user', content: { type: 'text', text: instruction } },
            {
                role: 'user',
                content: {
                    type: 'resource',
                    resource: { uri, mimeType: JSON_MIME, text: JSON.stringify(result.value, null, 2) },
                },
            },
        ],
    };
}

/**
 * **Never `ResourceNotFoundError` here**, however much the neighbouring file suggests it.
 *
 * That class produces a `-32602` whose `data` is `{ uri }`, which is exactly how a client is told
 * *a resource is absent* — our own browser client classifies precisely that shape as not-found. A
 * prompt raising it would report that the prompt does not exist, when what does not exist is a
 * task the argument named.
 *
 * `InvalidParams` with no `data` is the honest answer: the argument was wrong and is worth
 * retrying differently. That is the same reading `tools.ts` gives a 400.
 */
function failure(result: Extract<ApiResult<never>, { ok: false }>, notFoundId?: string): Error {
    if (result.kind === 'unreachable') {
        return new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Could not reach the task API: ${result.detail}. This is not something the arguments `
            + 'can fix; the service may be down.',
        );
    }
    if (result.status === 404 && notFoundId !== undefined) {
        return new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `No task with id '${notFoundId}'. Call tasks_list, or read tasks://tasks, to see valid ids.`,
        );
    }
    return new ProtocolError(
        ProtocolErrorCode.InternalError,
        `The task API returned HTTP ${result.status}. This is not something the arguments can fix; `
        + 'the service may be down.',
    );
}
