/**
 * Client for the task API.
 *
 * The wire types are duplicated here rather than shared through a package: this server is a
 * client of the API over HTTP, and a shared type would let a change on one side silently bind
 * the other. The duplication is the seam.
 *
 * Every call returns an `ApiResult` instead of throwing. That is deliberate — a 404 is a normal
 * outcome of `tasks_get`, not an exceptional one, and the Java implementation this replaces had
 * a bug where the not-found path was an accident of the HTTP client's null handling rather than
 * something the type system made you handle. Here the compiler will not let you forget it.
 */

export interface TaskResponse {
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    createdAt: string;
    updatedAt: string;
}

export interface TaskRequest {
    title: string;
    description?: string | undefined;
    status?: string | undefined;
    priority?: string | undefined;
}

export type ApiResult<T> =
    | { readonly ok: true; readonly value: T }
    /** The api answered, and said no. `status` is its HTTP status. */
    | { readonly ok: false; readonly kind: 'status'; readonly status: number }
    /** The api could not be reached at all — down, DNS, timeout. */
    | { readonly ok: false; readonly kind: 'unreachable'; readonly detail: string };

export class TasksClient {
    readonly #baseUrl: string;
    readonly #timeoutMs: number;

    constructor(baseUrl: string, timeoutMs = 10_000) {
        // Trailing slashes would produce `//tasks`, which nginx and Micronaut disagree about.
        this.#baseUrl = baseUrl.replace(/\/+$/, '');
        this.#timeoutMs = timeoutMs;
    }

    list(): Promise<ApiResult<TaskResponse[]>> {
        return this.#json<TaskResponse[]>('GET', '/tasks');
    }

    get(id: string): Promise<ApiResult<TaskResponse>> {
        return this.#json<TaskResponse>('GET', `/tasks/${encodeURIComponent(id)}`);
    }

    create(request: TaskRequest): Promise<ApiResult<TaskResponse>> {
        return this.#json<TaskResponse>('POST', '/tasks', request);
    }

    update(id: string, request: TaskRequest): Promise<ApiResult<TaskResponse>> {
        return this.#json<TaskResponse>('PUT', `/tasks/${encodeURIComponent(id)}`, request);
    }

    /** The api answers 204 with no body, so there is nothing to parse. */
    async delete(id: string): Promise<ApiResult<void>> {
        const response = await this.#send('DELETE', `/tasks/${encodeURIComponent(id)}`);
        if (!response.ok) {
            return response;
        }
        return { ok: true, value: undefined };
    }

    async #json<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
        const response = await this.#send(method, path, body);
        if (!response.ok) {
            return response;
        }
        try {
            return { ok: true, value: (await response.value.json()) as T };
        } catch (error) {
            return { ok: false, kind: 'unreachable', detail: `unreadable response body: ${message(error)}` };
        }
    }

    async #send(method: string, path: string, body?: unknown): Promise<ApiResult<Response>> {
        // A tool call that hangs is worse than one that fails: the model gets nothing to act on
        // and the client's own timeout fires with no explanation.
        const abort = AbortSignal.timeout(this.#timeoutMs);
        let response: Response;
        try {
            response = await fetch(`${this.#baseUrl}${path}`, {
                method,
                signal: abort,
                headers: body === undefined
                    ? { accept: 'application/json' }
                    : { accept: 'application/json', 'content-type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch (error) {
            return { ok: false, kind: 'unreachable', detail: message(error) };
        }
        if (!response.ok) {
            return { ok: false, kind: 'status', status: response.status };
        }
        return { ok: true, value: response };
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
