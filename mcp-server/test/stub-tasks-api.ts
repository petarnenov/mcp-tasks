/**
 * A stand-in for the task API, on a real HTTP server.
 *
 * Deliberately a real endpoint rather than a mocked `TasksClient`: the thing worth testing is the
 * whole path — MCP request, tool dispatch, HTTP call, response translation. A mock at the client
 * boundary would skip the half most likely to break.
 *
 * It reproduces the task API's contract only as far as these tests need: 404 for an unknown id,
 * 400 for a blank title, and PUT as a full replace.
 */

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { TaskResponse } from '../src/tasks-client.js';

const FIXED_CREATED_AT = '2026-08-23T00:00:00.000000Z';
const FIXED_UPDATED_AT = '2026-08-23T00:00:01.000000Z';

export interface StubTasksApi {
    readonly url: string;
    readonly store: TaskResponse[];
    /** Every request this stub has received. Lets a test prove a code path did NOT call the api. */
    readonly requests: { method: string; path: string }[];
    close(): Promise<void>;
}

export async function startStubTasksApi(): Promise<StubTasksApi> {
    const store: TaskResponse[] = [];
    const requests: { method: string; path: string }[] = [];

    const server: Server = createServer((request, response) => {
        const method = request.method ?? 'GET';
        const url = request.url ?? '/';
        requests.push({ method, path: new URL(url, 'http://stub').pathname });
        void handle(method, url, readBody(request), store)
            .then(({ status, body }) => {
                if (body === undefined) {
                    response.writeHead(status);
                    response.end();
                    return;
                }
                response.writeHead(status, { 'content-type': 'application/json' });
                response.end(JSON.stringify(body));
            });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('stub task api did not bind a TCP port');
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        store,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

async function handle(
    method: string,
    url: string,
    body: Promise<unknown>,
    store: TaskResponse[],
): Promise<{ status: number; body?: unknown }> {
    const path = new URL(url, 'http://stub').pathname;
    const id = path.startsWith('/tasks/') ? decodeURIComponent(path.slice('/tasks/'.length)) : undefined;

    if (method === 'GET' && path === '/tasks') {
        return { status: 200, body: store };
    }

    if (method === 'GET' && id !== undefined) {
        const found = store.find((task) => task.id === id);
        return found === undefined ? { status: 404 } : { status: 200, body: found };
    }

    if (method === 'POST' && path === '/tasks') {
        const request = (await body) as Record<string, string | undefined>;
        if (request['title'] === undefined || request['title'].trim() === '') {
            return { status: 400, body: { message: 'title must not be blank' } };
        }
        const created = materialize(randomUUID(), request, FIXED_CREATED_AT, FIXED_CREATED_AT);
        store.push(created);
        return { status: 201, body: created };
    }

    if (method === 'PUT' && id !== undefined) {
        const index = store.findIndex((task) => task.id === id);
        if (index === -1) {
            return { status: 404 };
        }
        const request = (await body) as Record<string, string | undefined>;
        if (request['title'] === undefined || request['title'].trim() === '') {
            return { status: 400, body: { message: 'title must not be blank' } };
        }
        // Full replace, mirroring the real API: omitted fields go back to defaults.
        const existing = store[index]!;
        const replaced = materialize(id, request, existing.createdAt, FIXED_UPDATED_AT);
        store[index] = replaced;
        return { status: 200, body: replaced };
    }

    if (method === 'DELETE' && id !== undefined) {
        const index = store.findIndex((task) => task.id === id);
        if (index !== -1) {
            store.splice(index, 1);
        }
        // 204 whether or not it existed — the api's idempotent delete.
        return { status: 204 };
    }

    return { status: 404 };
}

function materialize(
    id: string,
    request: Record<string, string | undefined>,
    createdAt: string,
    updatedAt: string,
): TaskResponse {
    return {
        id,
        title: request['title']!,
        description: request['description'] ?? null,
        status: request['status'] ?? 'TODO',
        priority: request['priority'] ?? 'MEDIUM',
        createdAt,
        updatedAt,
    };
}

async function readBody(request: NodeJS.ReadableStream): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw === '' ? {} : JSON.parse(raw);
}
