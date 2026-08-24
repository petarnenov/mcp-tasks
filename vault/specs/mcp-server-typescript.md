# MCP server (TypeScript)

**Status:** shipped
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-23

> **Shipped 2026-08-23.** Supersedes [[mcp-server]], which is the Java implementation this
> replaces. That spec stays as the record of the design decisions this one inherits — tool names,
> tool descriptions, the two entrances, the scaling argument. **Read it for the "why" behind
> anything this spec states without arguing for.**
>
> The one thing that changed is the language and the SDK, and that was forced by a protocol
> version. See [Why not Java](#why-not-java).

## Problem

The Java MCP server worked, but it could only ever speak **2025-11-25**. The current MCP
specification revision is **2026-07-28** — the "modern era": sessionless, with `server/discover`
replacing the `initialize` handshake and a per-request `_meta` envelope carrying the protocol
version. The MCP Inspector labels a 2025-11-25 connection `LEGACY`, which is what surfaced this.

That is not a configuration gap. It is missing from the JVM ecosystem entirely.

## Why not Java

Measured on 2026-08-23 by downloading each artifact and reading what is actually in it:

| SDK | Latest release | Max protocol revision | `server/discover` |
|---|---|---|---|
| **TypeScript** `@modelcontextprotocol/server` | **2.0.0** | **2026-07-28** | yes |
| **Python** `mcp` (PyPI) | **2.0.0** | **2026-07-28** | yes |
| Java `io.modelcontextprotocol.sdk:mcp-core` | 2.0.1 (2026-08-19) | 2025-11-25 | no |
| Kotlin `io.modelcontextprotocol:kotlin-sdk` | 0.15.0 (2026-07-28) | 2025-11-25 | no |

How the Java numbers were established, so nobody re-litigates this from memory: `mcp-core-2.0.1.jar`
was unzipped and its bytecode grepped for protocol-version strings. It contains exactly
`2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` — no `2026-07-28`, and no class implementing
`discover`. `kotlin-sdk-core-jvm-0.15.0.jar` gives the same four. `micronaut-mcp` 2.0.0 wraps
`mcp-core`, so it inherits the ceiling; there is no newer release of either.

The live Java server confirmed it from the other side: `server/discover` answered
`-32601 Missing handler`, and an `initialize` asking for `2026-07-28` was answered with
`2025-11-25`.

**Decision (2026-08-23):** rewrite in TypeScript rather than wait for the Java SDK or hand-roll the
modern era beside a `mcp-core` that pins 2025-11-25 internally. TypeScript over Python because the
SDK is the reference implementation there — the MCP Inspector itself is built on it.

**The cost, stated plainly:** the repository is no longer one language. [[micronaut-5-migration]]
records a deliberately uniform JVM stack, and this breaks it. What made the trade acceptable is
that `mcp-server` was a stateless proxy of 245 lines with all its logic behind `TASKS_API_URL` —
one replaceable container, not a subsystem. The same argument would **not** justify moving
`task-api`, which owns the database.

## Scope

- `mcp-server/` becomes a Node/TypeScript project: `package.json`, `tsconfig.json`, `src/`, `test/`.
- The **five tools are unchanged** — same names, same arguments, same descriptions as [[mcp-server]].
- The **2026-07-28 modern era** is served, and 2025-era clients keep working (see
  [Both eras](#both-eras)).
- Its own `node:24-alpine` Dockerfile, digest-pinned, replacing the Temurin one.
- `mcp-server` is removed from the Gradle build; `settings.gradle.kts` includes only `task-api`.
- `make build` and `make test` run **both** toolchains. New targets split them where useful.
- The compose healthcheck moves from `curl` to `node -e fetch(...)`.

**Non-goals:**
- Changing the task API, nginx routing, the ports, or the replica model. All unchanged.
- MCP prompts, resources, subscriptions, elicitation, or sampling. Tools only, as before.
  **Revised 2026-08-24:** all three primitives now ship — two resources ([[mcp-resources]]) and
  two prompts ([[mcp-prompts]]). Subscriptions, elicitation and sampling remain out.
- stdio transport.
- Authentication. It still inherits the api's posture, which is none.
- Rewriting `task-api`. It stays Micronaut 5 / Java 25.

## Design

### Layout

```
mcp-server/
  package.json            deps, and the scripts make calls
  package-lock.json       committed — `npm ci` in the image installs exactly this
  tsconfig.json           nodenext, strict, noUncheckedIndexedAccess
  Dockerfile              node:24-alpine, digest-pinned, multi-stage
  src/
    index.ts              entry point: env, listen, SIGTERM
    http.ts               the two routes, /mcp and /health
    server.ts             the per-request McpServer factory
    tools.ts              the five tools
    tasks-client.ts       fetch over the task API, plus its wire types
  test/
    mcp-server.test.ts    the correctness obligations below, via a real MCP client
    stub-tasks-api.ts     a real HTTP stand-in for the task API
```

`http.ts` is split from `index.ts` so tests can start a server on an ephemeral port. Importing
`index.ts` would bind 8877 as a side effect of loading the module.

### Both eras

`createMcpHandler(factory, { legacy: 'stateless' })`. That is the SDK's default, written out
because it is a decision:

- **Modern (2026-07-28)** clients get the sessionless envelope protocol, including `server/discover`.
- **2025-era** clients are still served — each request answered by a fresh instance over a
  stateless streamable-HTTP transport.

`legacy: 'reject'` would be the strict-modern posture. It was not chosen: it drops every client
that has not moved to the 2026 revision, and Claude Code, Claude Desktop and the MCP Inspector all
still default to the legacy handshake today.

**What "modern" means on the wire**, because it is what a hand-rolled `curl` gets wrong. A modern
request carries all of:

- `MCP-Protocol-Version: 2026-07-28` and an `Mcp-Method:` header naming the method,
- `params._meta` with `io.modelcontextprotocol/protocolVersion`,
  `io.modelcontextprotocol/clientCapabilities` and `io.modelcontextprotocol/clientInfo`,
- `Accept: application/json, text/event-stream`.

A POST without the `_meta` claim is classified **legacy** and routed to the legacy leg — including
one whose method is literally `server/discover`, which then answers `-32601`. That is correct
behaviour and not a bug; it cost an hour of confusion during verification and is why the
obligations below are driven by a real client and not by curl.

### Why this one can scale — unchanged, and now structural

[[mcp-server]] argued this at length: the api owns SQLite and cannot be replicated; the MCP server
owns nothing and can. Same here, but the property is harder to lose by accident.

`createMcpHandler` takes a **factory**, not a server. It builds one `McpServer` per request and
discards it. There is no instance that could accumulate state between requests, so "any replica
can answer any request" is a consequence of the API's shape rather than a claim to be maintained.

`server.ts` therefore exports `createServerFactory()` rather than a singleton, and the comment
there says why.

### Errors

Unchanged in behaviour from the Java version, but the not-found path is now typed rather than
accidental.

`TasksClient` returns an `ApiResult<T>` discriminated union — `{ok: true, value}`,
`{ok: false, kind: 'status', status}`, `{ok: false, kind: 'unreachable', detail}` — instead of
throwing. The Java implementation's second implementation note was a bug where a 404 arrived as a
`null` return and `tasks_get` cheerfully reported success with a body of `"null"`. Here the
compiler will not let a caller skip the failure arm.

Every tool still returns `isError: true` plus readable text rather than throwing, for the reason
the old spec's first implementation note gives: a thrown error reaches the model as an opaque
`-32603` with the message stripped.

One case is new: **the api being unreachable** now has its own message, distinct from an HTTP
status. `fetch` rejects rather than returning a status, and "connection refused" is a different
thing to tell a model than "the api said 500".

### Health

`GET /health` → `{"status":"UP","service":"tasks-mcp"}`, and it **does not call the task API**.
This answers "is this process up"; the api's own `/health` answers "is the api up". A probe that
called through would pull healthy MCP replicas out of the load balancer for a fault they cannot
fix. There is a test asserting the api receives no request.

The compose healthcheck runs `node -e "fetch(...)"` instead of `curl`. The Temurin JRE image
needed an `apt-get install curl` line for exactly this; `node:24-alpine` ships a runtime that can
make the request itself, so the extra package is unnecessary.

### No Host or Origin guard

The SDK ships `localhostHostValidation()` and `localhostOriginValidation()` for servers bound to
loopback on a developer's machine. Neither is used here: nginx rewrites `Host`, so both would
reject every proxied request. Stated so the omission reads as a decision rather than an oversight.
The endpoint's posture is unchanged from the Java server — see Non-goals.

### Container

`node:24-alpine`, pinned by digest, same convention as the other two images.

- `npm ci`, not `npm install`: it installs exactly what the committed lockfile pins and fails if
  the lockfile and manifest disagree, so the image cannot drift from what was tested.
- `npm ci --omit=dev` after the build prunes typescript, vitest and the client SDK.
- Runs as the image's existing non-root `node` user.
- `ENTRYPOINT ["node", "dist/index.js"]`, **not** `npm start`: npm as PID 1 does not forward
  SIGTERM, so every `make down` would wait out the kill timeout.
- `SIGTERM`/`SIGINT` are handled in `index.ts` — compose sends SIGTERM on `make down` and on every
  scale-down, and without a handler in-flight tool calls die with the process.

### Makefile

`build` and `test` fan out to both toolchains; the split targets exist so a change to one service
does not force the other's build.

```
build              -> build-api + build-mcp
build-api          -> ./gradlew build
build-mcp          -> npm ci && npm run build && npm test
test               -> test-api + test-mcp
run-mcp            -> npm run dev   (tsc, then node dist/index.js)
run-mcp-inspector  -> npx -y @modelcontextprotocol/inspector@2.3.0
clean              -> ./gradlew clean && rm -rf mcp-server/dist
```

`run-mcp-inspector` runs the *tool*, not the server — the server must already be up. The version is
pinned in `INSPECTOR` rather than left to `npx -y` resolving whatever is newest that day, so the
debugging tool cannot change under you mid-investigation. The target prints the endpoint and the
Protocol Era reminder before launching; see [Obligation 20](#obligation-20-and-the-inspectors-own-default).

`run-mcp` compiles first rather than running `src/index.ts` directly. Node strips TypeScript types
but does **not** resolve a `.js` import specifier to the `.ts` file beside it, so running the
sources fails on the first relative import.

## Correctness obligations

Numbered to match the test names in `mcp-server/test/mcp-server.test.ts`.

**Protocol**
1. A client pinned to **2026-07-28** connects, the negotiated version is `2026-07-28`, the era is
   `modern`, and the server names itself `tasks`.
2. `tools/list` returns exactly the five tools, each with a description and an object `inputSchema`.
3. A 2025-era client is still served, and negotiates `2025-11-25` on the `legacy` era.
4. Tools round-trip: a task created through MCP is visible through `tasks_list` and `tasks_get`.
5. Every request is self-contained — a task written by one connection is visible to a new one.

**Semantics preserved through the wrapper**
6. `tasks_update` with a field omitted resets it, matching [[task-api]] obligation 14, and
   (6b) the tool description says so.
7. `tasks_delete` succeeds on a real id, on a repeat call, and on an id that never existed.
8. `tasks_get` on an unknown id returns `isError: true` with a readable message — not a protocol
   error, not a stack trace, not an empty success.
9. Validation failures from the api arrive as readable tool errors.
10. An **unreachable** task API is reported as such, distinct from an HTTP status.

**HTTP surface**
11. `/health` answers 200 and sends **no** request to the task API.
12. An unknown path is a clean 404 naming the MCP endpoint.

**Deployment** — checked by hand, no automated coverage (see [[QUALITY]] gap 9)
13. `make up` brings up api, 3 MCP replicas and nginx, all healthy, api healthy before mcp starts.
14. `server/discover` returns `supportedVersions: ["2026-07-28"]` through **both** entrances,
    `:8877/mcp` and `:8080/mcp`.
15. Requests actually spread across replicas, measured from nginx's `ua="$upstream_addr"` field.
16. Killing a replica mid-flight does not break subsequent calls.
17. `docker compose up --scale api=2` still fails — the api interlock survived the rewrite.
18. `MCP_PORT=9877 make up` serves MCP on 9877 and nothing on 8877.
19. `GET :8080/tasks` still reaches the api, not the MCP server.
20. The MCP Inspector connects and lists the five tools.

## Verification

Run 2026-08-23 against a live stack: api + 3 MCP replicas + nginx, all healthy.

| # | Obligation | Result |
|---|---|---|
| 1 | Modern client, `2026-07-28`, era `modern` | pass — `{"name":"tasks","version":"0.1.0"}` |
| 2 | Five tools, described and schema'd | pass |
| 3 | 2025-era client still served | pass — negotiated `2025-11-25`, era `legacy`, five tools |
| 4 | Tools round-trip | pass |
| 5 | Requests are self-contained | pass |
| 6 | `tasks_update` resets omitted fields | pass — description, status and priority all reset |
| 6b | The description warns | pass |
| 7 | `tasks_delete` is idempotent | pass — three calls, no error |
| 8 | Unknown id is a readable tool error | pass |
| 9 | Validation failures are readable | pass |
| 10 | Unreachable api is reported as such | pass |
| 11 | `/health` does not call the api | pass — request count unchanged |
| 12 | Unknown path is a clean 404 | pass |
| 13 | `make up`, everything healthy | pass |
| 14 | `server/discover` on both entrances | pass — `supportedVersions: ["2026-07-28"]` on `:8877` and `:8080/mcp` |
| 15 | Requests spread across replicas | pass — measured **11 / 12 / 7** over 30 requests |
| 16 | Killing a replica | pass — `docker kill` one, then 12/12 succeeded |
| 17 | `--scale api=2` still fails | pass — refused, still one api container |
| 18 | `MCP_PORT=9877 make up` | pass — 9877 serves, 8877 refuses |
| 19 | `:8080/tasks` still reaches the api | pass — 200 |
| 20 | The MCP Inspector connects | pass — CLI listed all five tools |

**Obligations 1–12 are automated** (13 vitest tests). 13–20 were run by hand — the same gap the
Java version had, unchanged by this work.

### Obligation 20 and the Inspector's own default

The Inspector connects, but its **Protocol Era** setting defaults to `Legacy (2025-11-25
handshake)` — its docstring says "debugging tools should not auto-probe". A connection to this
server will therefore show `LEGACY` until the era is changed to `Auto` or `Modern` in the server's
Settings panel. That is the Inspector's default, not this server's ceiling: obligation 14 is what
proves the modern era is served.

### Image size

`tasks-mcp` is **176MB**, against 400MB for `tasks` (the Temurin-based api). Not a goal, recorded
because it is the visible consequence of the base image change.

## Implementation notes

**1. A hand-built `server/discover` POST is classified legacy.** The first live check sent
`{"method":"server/discover"}` with no `_meta` envelope and got `-32601 Method not found`, which
reads exactly like "the server does not implement it". It does. Era classification is by the
`_meta` protocol-version claim, and a claim-less POST goes to the legacy leg whatever its method
name — the SDK documents this explicitly. **Verify the protocol with a real client**, then use
curl only to confirm a shape you already know is right.

**2. `CallToolResult` must be the SDK's type, not a look-alike.** A locally declared
`interface ToolResult { content: ...; isError?: boolean }` fails to satisfy `registerTool`, because
`CallToolResult` is a union whose other arm is the multi-round-trip `InputRequiredResult`. The
resulting overload error names `resultType` — a property from an arm you never intended to use —
and sends you looking in the wrong place.

**3. `task-api/Dockerfile` copied `mcp-server/build.gradle.kts`.** It was a build input back when
both were Gradle modules. Deleting the file broke the *api* image build with a checksum error
naming a path that no longer exists. Nothing in the api's own sources referenced it.

**4. The compose healthcheck could not stay as it was.** `curl` was a real binary in the Temurin
image only because [[docker-and-make]] deliberately installed it. `node:24-alpine` has none, and
adding one to run a probe that `node -e "fetch(...)"` already performs would be a package installed
for nothing.

## Open questions

None. Decided by the owner on 2026-08-23:

| Was open | Decided |
|---|---|
| Wait for the Java SDK, hand-roll modern era, or change language? | **Change language** — the JVM ceiling is upstream and not close to moving |
| TypeScript or Python? | **TypeScript** — the reference implementation, and what the Inspector itself is built on |
| Serve modern only, or both eras? | **Both** — `legacy: 'stateless'`, because every current client still defaults to the 2025 handshake |
| Keep the Gradle module as a wrapper? | **No** — `mcp-server` leaves the Gradle build entirely; `make` is the layer that knows about both toolchains |

Record new questions here rather than deciding them silently in code.
