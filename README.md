# mcp-tasks

A task list you can drive from a conversation. A CRUD API in Java, an
[MCP](https://modelcontextprotocol.io) server in TypeScript that exposes it to a model as tools,
resources and prompts, and a browser MCP client for looking at all of it by hand — behind nginx, in
Docker, started with one command.

It is a working system rather than a sketch: 113 tests, digest-pinned images, a proxy that survives
a backend restart, and documentation that is checked against the code rather than written from
memory.

```
make up
```

Then:

| | |
|---|---|
| Task API | <http://localhost:8080/tasks> |
| MCP endpoint | <http://localhost:8080/mcp> — and `:8877` on its own listener |
| Browser MCP client | <http://localhost:8080/mcp/client> |

`make` on its own lists every target. Nothing else in this repository needs to be memorised.

## What a model sees

The MCP server serves protocol revision **2026-07-28**, and offers all three primitives.

**Five tools**

| Tool | Does |
|---|---|
| `tasks_list` | Every task, with status and priority |
| `tasks_get` | One task by id |
| `tasks_create` | Create one and return it |
| `tasks_update` | **Full replace, not a patch** — an omitted field resets to its default |
| `tasks_delete` | Idempotent; deleting a missing id is not an error |

**Two resources** — `tasks://tasks` for the whole list, and the `tasks://tasks/{id}` template, which
completes ids as you type. A tool call is an action the model chose; a resource read is material a
person attached. Same data, different door.

**Two prompts** — `triage_tasks` and `plan_task`, each embedding the resource it discusses rather
than linking to it, because a link is only material if the client follows it, and many do not.

Every tool reports failure as `isError: true` with a readable message, never as a thrown JSON-RPC
error — a model can act on the former and not the latter.

## The HTTP API underneath

| Method | Path | Result |
|---|---|---|
| `POST` | `/tasks` | `201` with a `Location` header |
| `GET` | `/tasks` | Every task |
| `GET` | `/tasks/{id}` | One, or `404` with an `ApiError` body |
| `PUT` | `/tasks/{id}` | Full replace, or `404` |
| `DELETE` | `/tasks/{id}` | `204`, always — idempotent |

A task is a title, an optional description, a status (`TODO` / `IN_PROGRESS` / `DONE`) and a
priority (`LOW` / `MEDIUM` / `HIGH`). No due dates, no assignees, no accounts.

## Layout

| Module | Language | Owns |
|---|---|---|
| `task-api/` | Java 25, Micronaut 5 | The five routes, the business rules, the SQLite schema |
| `mcp-server/` | TypeScript, Node 24 | The MCP surface. A stateless proxy — it holds nothing |
| `mcp-client/` | TypeScript, browser | The client page. Static files, no process, no container |
| `nginx/` | — | The only published ports. Both backends publish nothing |
| `vault/` | — | Architecture, one spec per feature, and the quality gates |

## Why two languages

Not a preference. The MCP **Java** SDK implements up to protocol revision 2025-11-25; the current
revision is 2026-07-28, and the TypeScript SDK implements it. That is the whole argument, and it
was settled by unzipping the artifacts rather than by reading changelogs — the measurement is in
[`vault/specs/mcp-server-typescript.md`](vault/specs/mcp-server-typescript.md).

It does not license a second language anywhere else. `mcp-server` is a stateless proxy behind one
environment variable, so replacing it is cheap. `task-api` owns the database.

## Scaling, and its one asymmetry

The MCP server runs **3 replicas** by default (`make scale REPLICAS=n`). The api runs **exactly
one**, and `container_name: tasks-api` in `compose.yaml` makes `--scale api=2` fail outright. That
line is a safety interlock, not cosmetics: SQLite takes a single writer, so a second api replica is
data corruption rather than throughput.

The MCP server can scale because it is stateless by construction — one `McpServer` is built per
request and discarded, so no state can survive between requests, and any replica can answer
anything. Scaling it does not raise the ceiling, though; the calls still funnel into one api.

## Development

```sh
make build        # compile, typecheck and test all three modules
make test         # 113 tests: 23 api (JUnit) + 40 mcp + 50 client (vitest)
make run          # api on :8080, no Docker
make run-mcp      # MCP server on :8877, needs `make run` in another shell
make ps           # container status and health
make logs         # follow everything
make down         # stop; ./data survives
```

**Requirements.** Java 25 and Node 24+ for a host build — the Gradle build provisions a JDK through
the foojay resolver if you have none. Docker for `make up`. Nothing else, and no credentials: this
project calls no third-party service.

## Status and limits

Honest ones, in more detail in [`vault/QUALITY.md`](vault/QUALITY.md):

- **Single user, single writer, no authentication.** It is meant to be started, used and stopped by
  the person who owns the machine. Do not put it on a network you do not control.
- **`GET /tasks` returns every row.** There is no pagination, and behaviour at 100k tasks is
  untested.
- **The container has only ever run on macOS.** A non-root container writing to a bind mount can
  fail on Linux for ownership reasons that Docker Desktop hides.
- **No CI.** Every gate is a human running `make test`.

## Documentation

[`vault/`](vault/) is the real documentation, and it is kept accurate deliberately:

- [`ARCHITECTURE.md`](vault/ARCHITECTURE.md) — components, flow, boundaries, and the non-obvious
  decisions with their reasons.
- [`specs/`](vault/specs/) — one file per feature, each with numbered correctness obligations and
  the verification that was actually run.
- [`QUALITY.md`](vault/QUALITY.md) — the gate commands, and a known-gaps list that says what is not
  covered rather than implying everything is.

## License

[MIT](LICENSE) © 2026 Petar Nenov
