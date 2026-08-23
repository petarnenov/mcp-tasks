/**
 * The task API exposed as MCP tools.
 *
 * Names are prefixed with `tasks_` so they cannot collide when a client is connected to several
 * servers at once. Some clients namespace by server name themselves, in which case these appear
 * doubly prefixed; that was accepted in exchange for names that stand alone.
 *
 * Every tool returns a result rather than throwing. A failure is reported with `isError: true`
 * and a readable message, which is what MCP asks for: JSON-RPC protocol errors are for malformed
 * requests, while a tool that ran and could not do the job should hand the model something it
 * can read and act on.
 *
 * Nothing here holds state. That is what allows the service to be scaled horizontally, unlike the
 * task API behind it, which owns a SQLite file and must stay single-writer.
 */

import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { ApiResult, TasksClient } from './tasks-client.js';

/**
 * The SDK's own result type, not a hand-rolled one. `CallToolResult` is a union whose other arm
 * is the multi-round-trip `InputRequiredResult`; a structurally similar local interface does not
 * satisfy it and the overload resolution failure it produces names the wrong thing.
 */
type ToolResult = CallToolResult;

const idArg = z.string().describe("The task's UUID, as returned by tasks_list");

const titleArg = z.string().describe('Short title. Required, max 200 characters');

export function registerTaskTools(server: McpServer, tasks: TasksClient): void {
    server.registerTool(
        'tasks_list',
        {
            description: 'List every task, with its status and priority.',
            inputSchema: z.object({}),
        },
        async () => render(await tasks.list()),
    );

    server.registerTool(
        'tasks_get',
        {
            description: 'Fetch a single task by its id.',
            inputSchema: z.object({ id: idArg }),
        },
        async ({ id }) => render(await tasks.get(id), { notFoundId: id }),
    );

    server.registerTool(
        'tasks_create',
        {
            description: 'Create a new task and return it.',
            inputSchema: z.object({
                title: titleArg,
                description: z
                    .string()
                    .optional()
                    .describe('Optional longer description, max 2000 characters'),
                status: z
                    .enum(['TODO', 'IN_PROGRESS', 'DONE'])
                    .optional()
                    .describe('One of TODO, IN_PROGRESS, DONE. Defaults to TODO'),
                priority: z
                    .enum(['LOW', 'MEDIUM', 'HIGH'])
                    .optional()
                    .describe('One of LOW, MEDIUM, HIGH. Defaults to MEDIUM'),
            }),
        },
        async ({ title, description, status, priority }) =>
            render(await tasks.create({ title, description, status, priority })),
    );

    // The description spells out the replace semantics on purpose. This is a PUT underneath, and
    // a model that assumes patch semantics will wipe a task's priority while "just fixing the
    // title". The tool description is the only place it can learn that. Do not trim it.
    server.registerTool(
        'tasks_update',
        {
            description:
                'Replace a task. This is a full replace, NOT a patch: any field you omit is reset '
                + 'to its default rather than left unchanged. Omitting description clears it; '
                + 'omitting status resets it to TODO; omitting priority resets it to MEDIUM. To '
                + 'change one field, call tasks_get first and pass every other value back unchanged.',
            inputSchema: z.object({
                id: idArg,
                title: titleArg,
                description: z
                    .string()
                    .optional()
                    .describe('Optional longer description. Omit to clear it'),
                status: z
                    .enum(['TODO', 'IN_PROGRESS', 'DONE'])
                    .optional()
                    .describe('One of TODO, IN_PROGRESS, DONE. Omit to reset to TODO'),
                priority: z
                    .enum(['LOW', 'MEDIUM', 'HIGH'])
                    .optional()
                    .describe('One of LOW, MEDIUM, HIGH. Omit to reset to MEDIUM'),
            }),
        },
        async ({ id, title, description, status, priority }) =>
            render(await tasks.update(id, { title, description, status, priority }), { notFoundId: id }),
    );

    // Idempotence has to be stated, or a model treats a second call as an error worth reporting.
    server.registerTool(
        'tasks_delete',
        {
            description:
                'Delete a task. Idempotent: it succeeds whether or not the task existed, so a '
                + 'repeat call is not an error.',
            inputSchema: z.object({ id: idArg }),
        },
        async ({ id }) => {
            const result = await tasks.delete(id);
            if (!result.ok) {
                return failure(result);
            }
            return text(`Deleted task ${id} (or it did not exist).`);
        },
    );
}

/** Success becomes the api's JSON verbatim; failure becomes a message the model can act on. */
function render<T>(result: ApiResult<T>, context: { notFoundId?: string } = {}): ToolResult {
    if (result.ok) {
        return text(JSON.stringify(result.value, null, 2));
    }
    return failure(result, context);
}

function failure(result: Extract<ApiResult<never>, { ok: false }>, context: { notFoundId?: string } = {}): ToolResult {
    if (result.kind === 'unreachable') {
        return error(
            `Could not reach the task API: ${result.detail}. This is not something the arguments `
            + 'can fix; the service may be down.',
        );
    }
    if (result.status === 404 && context.notFoundId !== undefined) {
        return error(`No task with id '${context.notFoundId}'. Call tasks_list to see valid ids.`);
    }
    // A 400 means the arguments were wrong and are worth retrying differently; anything else is
    // not the caller's fault, and saying so stops the model from retrying pointlessly.
    if (result.status === 400) {
        return error(
            'The task API rejected the request. Check that title is non-blank and under 200 '
            + 'characters, status is one of TODO/IN_PROGRESS/DONE, and priority is one of '
            + 'LOW/MEDIUM/HIGH.',
        );
    }
    return error(
        `The task API returned HTTP ${result.status}. This is not something the arguments can `
        + 'fix; the service may be down.',
    );
}

function text(body: string): ToolResult {
    return { content: [{ type: 'text', text: body }] };
}

function error(body: string): ToolResult {
    return { content: [{ type: 'text', text: body }], isError: true };
}
