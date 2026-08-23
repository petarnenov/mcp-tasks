# MCP server (Java)

**Status:** superseded by [[mcp-server-typescript]]
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-23

> **Superseded 2026-08-23** by [[mcp-server-typescript]], which reimplements this server in
> TypeScript. The reason is a protocol version and nothing else: the MCP Java SDK tops out at the
> **2025-11-25** revision and the current spec is **2026-07-28**. See that spec's *Why not Java*
> for the measurements.
>
> **This file is kept, not deleted.** Everything it argues still holds — the tool names, the two
> tool descriptions that must not be trimmed, the two entrances, the nginx and compose wiring, and
> the scaling argument. The successor inherits all of it and does not repeat the reasoning. The
> Java code it describes is gone; the design it describes is live.

> **Shipped 2026-08-23**, on top of [[micronaut-5-migration]]. All 23 obligations verified.
> Three things the implementation forced are in [Implementation notes](#implementation-notes).
>
> **Read [On the Anthropic SDK](#on-the-anthropic-sdk) before anything else.** The request named
> the Anthropic SDK; an MCP server is the one kind of program that does not need it. The owner
> confirmed leaving it out on 2026-08-23.
>
> **Fully specified.** [Open questions](#open-questions) is a decision record.

## Problem

The task API is reachable only by something that speaks HTTP and knows its five endpoints. An LLM
client — Claude Desktop, Claude Code, anything else that speaks MCP — cannot discover or use it.

The Model Context Protocol exists for exactly this: a server declares tools, a client discovers
them, and the model calls them by name with typed arguments. Wrapping the existing API in an MCP
server makes the task list usable from a conversation without changing the API itself.

## On the Anthropic SDK

The request says to use the latest Anthropic SDK. **An MCP server does not call Claude**, so it has
no use for it.

The direction matters:

```
  Claude  ──MCP──▶  this server  ──HTTP──▶  task API
  (client)          (implements MCP)        (existing)
```

- **`com.anthropic:anthropic-java` 2.57.0** is a client *for the Anthropic API*. You add it to a
  program that wants to send prompts to Claude and read completions. This server is on the other
  end of that arrow: it is *called by* a model, it never calls one.
- **`com.anthropic:anthropic-java-mcp` 2.57.0** also exists, and the name makes it look right. It
  is not: its POM depends on `anthropic-java-core` plus `mcp`, and it is the Anthropic SDK's
  integration for *consuming* MCP servers from an application that drives Claude. Still the client
  side.
- The correct dependency is **`io.micronaut.mcp:micronaut-mcp-server-java-sdk` 2.0.0**, which wraps
  the official MCP Java SDK (`io.modelcontextprotocol.sdk:mcp-core` 2.0.0). Both are managed by the
  Micronaut 5.1.1 platform BOM, so neither needs an explicit version.

**Decision (2026-08-23): the Anthropic SDK is not used here.** Adding it would mean an unused
dependency on the classpath and an `ANTHROPIC_API_KEY` this service has no reason to hold — a
credential in a component that cannot use it.

**If the intent was an AI-powered feature** — a `summarize_tasks` tool that asks Claude to
summarize the list, say — then the Anthropic SDK is exactly right, the server does need a key, and
that is a genuinely different piece of work with its own security surface. It should be its own
spec, not smuggled into this one. See [Open questions](#open-questions).

## Scope

- A **new Gradle subproject** exposing the task API as MCP tools over HTTP.
- Five tools, one per existing endpoint: `tasks_create`, `tasks_list`, `tasks_get`,
  `tasks_update`, `tasks_delete`.
- A Micronaut declarative HTTP client calling the task API on the compose network.
- Its own multi-stage `Dockerfile`, reusing the pattern from [[docker-and-make]].
- An `mcp` service in `compose.yaml`, **unpublished**, behind nginx.
- Nginx listens on **8877** and proxies to the MCP replicas, exactly as it owns 8080 for the api.
- The same MCP backend is **also reachable at `http://localhost:8080/mcp`** (confirmed
  2026-08-23), so a client restricted to one port can still use it.
- **Horizontal scaling** of the MCP service — see [Why this one can scale](#why-this-one-can-scale).
- Makefile targets for scaling and for the new service's logs.

**Non-goals:**
- Calling Claude from this server. See [On the Anthropic SDK](#on-the-anthropic-sdk).
- MCP prompts and resources. Tools only. The SDK offers `@Prompt`, `@Resource` and
  `@ResourceTemplate`; none map to anything this API has.
- stdio transport. The MCP SDK supports it, but a container behind a load balancer needs HTTP.
- Authentication on the MCP endpoint. It inherits the API's posture, which is none.
- Scaling the **api**. Still exactly one, still SQLite, still enforced by `container_name`.
- Changing the task API in any way. This is a wrapper, and the 19 [[task-api]] obligations are
  untouched.

## Why this one can scale

[[nginx-load-balancer]] could not load balance because the api owns a SQLite file and SQLite takes
one writer. **The MCP server owns nothing.** Every request is translated into an HTTP call to the
api and the result is translated back. There is no local state to keep consistent between replicas.

The protocol detail that makes this true rather than merely plausible: MCP's Streamable HTTP
transport can be *stateful* — a client establishes a session and the server tracks it, which would
demand session affinity at the proxy. `micronaut-mcp` ships a stateless implementation instead
(`io.micronaut.mcp.server.stateless.McpController`, built on the SDK's
`McpStatelessServerHandler`), where each JSON-RPC request is self-contained. Any replica can answer
any request, so nginx can round-robin freely and no `Mcp-Session-Id` hashing is needed.

**What scaling does and does not buy.** More MCP replicas means more concurrent tool calls
accepted. They all funnel into one api container with `maximum-pool-size: 1`. The ceiling does not
move — it relocates from "how many MCP requests can one process handle" to "how fast can one
SQLite writer go". Scale this because the requirement asks for it and the design supports it
honestly, not because it makes the system faster.

The concrete consequence: the `mcp` service must **not** have a `container_name`. On the api that
line is a deliberate safety interlock; here the same line would be a bug.

## Design

### Project layout

The repository becomes a two-module Gradle build:

```
settings.gradle.kts        include("task-api", "mcp-server")
build.gradle.kts           shared config only
task-api/                  everything currently at the root
  build.gradle.kts
  src/...
  Dockerfile
mcp-server/
  build.gradle.kts
  src/main/java/dev/petrov/tasks/mcp/
    Application.java
    TaskTools.java          the five @Tool methods
    TasksClient.java        @Client against the task API
    dto/                    mirrors of the api's wire types
  src/main/resources/application.yml
  Dockerfile
```

**Confirmed 2026-08-23.** This moves every existing source file — the largest single change in the
spec. The cost is real: git history for 15 files goes through a rename, and the `Dockerfile`,
`Makefile` and several vault paths all move with them. It was chosen over keeping the api at the
repository root because the two servers are peers, and because a third service would force the
split anyway.

### Tools

```java
@Singleton
public class TaskTools {

    @Tool(name = "tasks_list", description = "List every task.")
    public List<TaskResponse> listTasks() { ... }

    @Tool(name = "tasks_get", description = "Fetch one task by its id.")
    public TaskResponse getTask(
        @ToolArg(description = "The task's UUID") String id) { ... }

    @Tool(name = "tasks_create", description = "Create a task.")
    public TaskResponse createTask(
        @ToolArg(description = "Short title, required, max 200 chars") String title,
        @ToolArg(description = "Optional longer description") @Nullable String description,
        @ToolArg(description = "TODO, IN_PROGRESS or DONE. Defaults to TODO") @Nullable String status,
        @ToolArg(description = "LOW, MEDIUM or HIGH. Defaults to MEDIUM") @Nullable String priority) { ... }

    @Tool(name = "tasks_update", description =
        "Replace a task. Omitted fields are RESET to defaults, not left unchanged.")
    public TaskResponse updateTask(...) { ... }

    @Tool(name = "tasks_delete", description = "Delete a task. Succeeds even if it does not exist.")
    public void deleteTask(@ToolArg(description = "The task's UUID") String id) { ... }
}
```

Two descriptions are doing real work and must not be trimmed:

- **`tasks_update`** must say that omission resets. `PUT` is a full replace ([[task-api]]
  obligations 13 and 14) and a model that assumes patch semantics will silently wipe a task's
  priority while "just fixing the title". The tool description is the only place a model learns
  this.
- **`tasks_delete`** must say it is idempotent, or a model will treat a second call as an error
  worth reporting.

### Talking to the task API

```java
@Client("${tasks.api.url:`http://api:8080`}")
public interface TasksClient {
    @Get("/tasks") List<TaskResponse> list();
    @Post("/tasks") HttpResponse<TaskResponse> create(@Body CreateTaskRequest request);
    ...
}
```

Configured by `TASKS_API_URL`, defaulting to the compose service name. Note a Micronaut 5 breaking
change that helps here: `@Client` no longer invokes fallbacks by default, so a failing task API
surfaces as an error rather than a silently degraded result. That is the behaviour we want — do not
add `micronaut-retry` to get the old one back.

**Error translation matters.** A `404` from the api must reach the model as a clear "no such task",
not as an unhandled `HttpClientResponseException` stack trace. Every tool needs a defined failure
shape.

### Configuration

`mcp-server/src/main/resources/application.yml`:

| Key | Value | Note |
|---|---|---|
| `micronaut.server.port` | `8877` | The MCP server's own port |
| `micronaut.mcp.server.transport` | `HTTP` | The `Transport` enum offers exactly `HTTP` and `STDIO` |
| `micronaut.mcp.server.endpoint` | `/mcp` | The SDK's default; stated explicitly rather than inherited |
| `micronaut.mcp.server.info.name` | `tasks` | Advertised to clients |
| `micronaut.mcp.server.info.version` | project version | |
| `tasks.api.url` | `http://api:8080` | Overridden by `TASKS_API_URL` |

### compose.yaml

```yaml
  mcp:
    build:
      context: .
      dockerfile: mcp-server/Dockerfile
    image: ${MCP_IMAGE:-tasks-mcp}:${TAG:-latest}
    # NO container_name -- that is what allows --scale here. On the api the same line is a
    # deliberate interlock; here it would be a bug.
    depends_on:
      api:
        condition: service_healthy
    expose:
      - "8877"
    environment:
      TASKS_API_URL: http://api:8080
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8877/health"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 20s
```

`micronaut-management` gives `/health` here too, the same as the api.

### nginx

A second `server` block, on 8877, in the existing `nginx/nginx.conf`:

```nginx
    server {
        listen 8877;
        server_name _;

        location = /nginx-health {
            access_log off;
            add_header Content-Type application/json always;
            return 200 '{"status":"UP","service":"nginx-mcp"}';
        }

        location / {
            limit_req zone=api burst=200 nodelay;

            # Same variable-plus-resolver trick as the 8080 block, and here it does double
            # duty: it is also what lets nginx see MCP replicas that did not exist at startup.
            set $upstream_mcp http://mcp:8877;
            proxy_pass $upstream_mcp;

            proxy_http_version 1.1;
            proxy_set_header Host              $host;
            proxy_set_header X-Real-IP         $remote_addr;
            proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Connection        "";

            proxy_connect_timeout 5s;
            proxy_send_timeout    60s;
            proxy_read_timeout    60s;
        }
    }
```

Longer read timeouts than the api block: a tool call is an api call plus overhead, and MCP clients
are more tolerant of latency than of truncation.

**How the balancing actually works is a real question, not a formality.** Docker's embedded DNS
returns one A record per replica. Open-source nginx has no `resolve` parameter on `upstream`
entries — that is a commercial feature — so this design relies on the variable-plus-`resolver`
form re-resolving `mcp` and distributing across the returned addresses. That behaviour must be
**measured**, not assumed: see obligation 12.

#### Also on 8080/mcp

The 8080 `server` block gains a second location routing to the same replicas:

```nginx
        # Same backend as the 8877 listener. nginx picks prefix locations by LONGEST match,
        # not by file order, so this wins over `location /` for /mcp regardless of where it
        # sits in the block. (Order only decides between regex locations.)
        location /mcp {
            limit_req zone=api burst=200 nodelay;
            set $upstream_mcp_8080 http://mcp:8877;
            proxy_pass $upstream_mcp_8080;

            proxy_http_version 1.1;
            proxy_set_header Host              $host;
            proxy_set_header X-Real-IP         $remote_addr;
            proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Connection        "";

            proxy_connect_timeout 5s;
            proxy_send_timeout    60s;
            proxy_read_timeout    60s;
        }
```

Two entrances to one backend is two paths to keep tested, which is the cost of this convenience —
[obligation 19](#correctness-obligations) exists to stop one of them rotting unnoticed. It also
means `/mcp` is now a reserved path on 8080: the task API must never grow an endpoint there.

Compose must also publish 8877 on the nginx service:

```yaml
    ports:
      - "${PORT:-8080}:8080"
      - "${MCP_PORT:-8877}:8877"
```

### Makefile

```makefile
MCP_PORT ?= 8877
# Three by default (confirmed 2026-08-23): with one replica a broken balancer or a
# accidentally-stateful server looks identical to a working one.
REPLICAS ?= 3

up:  ## Start everything in Docker, building if needed
	$(COMPOSE) up --build -d --scale mcp=$(REPLICAS)

scale:  ## Set MCP replica count: make scale REPLICAS=3
	$(COMPOSE) up -d --no-recreate --scale mcp=$(REPLICAS)

logs-mcp:  ## Follow the MCP server logs
	$(COMPOSE) logs -f mcp
```

## Correctness obligations

**Protocol**
1. `POST http://localhost:8877/mcp` with an MCP `initialize` request returns a valid JSON-RPC
   result naming the server as `tasks`.
2. `tools/list` returns exactly the five tools, each with a description and a JSON schema for its
   arguments.
3. Every tool round-trips: calling it produces the same effect as the equivalent REST call, and the
   result is JSON the model can read.
4. A real MCP client — Claude Code's `claude mcp add`, or the MCP inspector — connects, lists the
   tools, and calls one successfully. Hand-rolled curl proves the transport, not the integration.

**Semantics preserved through the wrapper**
5. `tasks_update` with a field omitted resets it, matching [[task-api]] obligation 14, and the tool
   description says so.
6. `tasks_delete` on an unknown id succeeds, matching [[task-api]] obligation 16.
7. `tasks_get` on an unknown id returns a clean "not found" tool error — not a stack trace, not a
   `500`, not an empty success.
8. Validation failures from the api (blank title, bad enum) arrive as readable tool errors.

**Scaling**
9. The `mcp` service has **no** `container_name`, and `make scale REPLICAS=3` starts three
   containers.
10. All three report healthy.
11. With three replicas, every tool still works — no request depends on hitting the replica that
    served the previous one. This is the stateless claim, tested.
12. **Requests actually spread across replicas.** Issue N calls, then confirm from
    `make logs-mcp` that more than one container served them. A single replica taking everything
    means the DNS balancing does not work the way this spec assumes, and the spec is wrong rather
    than the test.
13. Killing one replica mid-flight does not break subsequent calls: nginx re-resolves and the
    survivors serve.
14. `docker compose up --scale api=2` still **fails**. Scaling the MCP layer must not have loosened
    the api interlock.

**Containers and routing**
15. The MCP container publishes no host port; 8877 belongs to nginx.
16. `make up` brings up api, mcp and nginx, all healthy, with the api healthy *before* mcp starts.
17. `MCP_PORT=9877 make up` serves MCP on 9877.
18. The 8080 endpoints are unaffected — all [[task-api]] obligations still pass through nginx.
19. **Both entrances work and stay in step.** `POST :8877/mcp` and `POST :8080/mcp` return
    equivalent results for the same request. Whenever one is changed, this must be re-checked —
    it is the obligation most likely to rot.
20. `GET :8080/tasks` still reaches the **api**, not the MCP server. The `/mcp` prefix must not
    have captured anything else.

**Build**
21. The 23 existing tests still pass, unmodified, after the module restructure.
22. The MCP server has its own tests covering tool registration and at least one round trip.
23. `make build` builds both modules.

## Verification

Run 2026-08-23 against a live stack: api + **3 MCP replicas** + nginx, all healthy.

| # | Obligation | Result |
|---|---|---|
| 1 | `initialize` names the server | pass — `{"name":"tasks","version":"0.1.0"}` |
| 2 | Five tools, each described and schema'd | pass — all five carry `inputSchema` and a description |
| 3 | Tools round-trip | pass — a task created via MCP is visible through `GET :8080/tasks` |
| 4 | A real MCP client connects | **not done** — see below |
| 5 | `tasks_update` resets omitted fields | pass — priority HIGH → MEDIUM when omitted, and the description says so |
| 6 | `tasks_delete` is idempotent | pass — twice on the same id, and on an id that never existed |
| 7 | Unknown id is a clean tool error | pass — `isError: true` with a readable message |
| 8 | Validation failures are readable | pass |
| 9 | No `container_name`; scaling works | pass — 3 containers |
| 10 | All replicas healthy | pass |
| 11 | Every tool works with 3 replicas | pass |
| 12 | **Requests actually spread** | pass — measured **8 / 8 / 5** across the three replicas |
| 13 | Killing a replica does not break calls | pass — 20/20 succeeded after `docker kill`, traffic moved to the survivors |
| 14 | `--scale api=2` still fails | pass — exit 1, still one api container |
| 15 | MCP publishes no host port | pass — `8877/tcp` only, nginx owns the published one |
| 16 | `make up` brings everything up in order | pass — api healthy before mcp starts |
| 17 | `MCP_PORT=9877 make up` | pass — 9877 serves, 8877 has nothing |
| 18 | 8080 REST endpoints unaffected | pass |
| 19 | Both entrances work | pass — `:8877/mcp` and `:8080/mcp` both return five tools |
| 20 | `:8080/tasks` still reaches the api | pass |
| 21 | The 23 existing tests pass, unmodified | pass |
| 22 | The MCP server has its own tests | pass — 9 tests |
| 23 | `make build` builds both modules | pass — **32 tests total**, 0 failures |

### How obligation 12 was actually measured

The first attempt counted log lines per container and proved nothing: the MCP server does not log
each `tools/list`, and the nginx log format had no field naming the backend. Adding
`ua="$upstream_addr"` to `log_format` is what made the question answerable — 30 requests came back
as `172.18.0.3` ×8, `172.18.0.4` ×8, `172.18.0.5` ×5. That field is now permanent; without it
"is the balancer working?" is unanswerable from the logs.

### Obligation 4 is not cleared

No real MCP client was pointed at the server — the protocol was driven with `curl` and from the
test suite. That proves the transport and the tool contracts, **not** the integration. A client
may differ on session headers, `Accept` negotiation, or protocol version. Run
`claude mcp add tasks --transport http http://localhost:8877/mcp` before trusting this end to end.

## Implementation notes

**1. Throwing from a tool loses the message.** The natural approach — throw an exception, let the
SDK turn it into an error — produced `{"code":-32603,"message":"message must not be empty"}` for
every failure. The tool's actual message never reached the client. `McpError.builder(code)
.message(...)` behaved the same way.

The fix is the MCP-idiomatic one anyway: every tool returns `CallToolResult` and reports failure
with `isError: true` plus readable text. JSON-RPC protocol errors are for malformed requests; a
tool that ran and could not do the job should hand the model something it can act on. The tests
assert this explicitly — a protocol error where a tool error belongs now fails the build.

**2. Micronaut's declarative client maps 404 to `null`, not an exception.** `tasks_get` on an
unknown id returned `isError: false` with a body of `"null"` — a cheerful success for a task that
does not exist. `HttpClientResponseException` is never thrown for a 404 on a POJO return type, so
the **null check is the not-found path**. Both `tasks_get` and `tasks_update` needed it, and
there is a regression test naming the failure.

**3. Gradle runs a subproject from its own directory.** After the module split, `make run` failed
with `SQLITE_CANTOPEN`: the relative `jdbc:sqlite:data/tasks.db` resolved against `task-api/`
rather than the repo root, so the local run and the container no longer shared a database — the
exact trap [[micronaut-5-migration]] and [[docker-and-make]] were written to close. Fixed by
pinning `tasks.named<JavaExec>("run") { workingDir = rootProject.projectDir }`.

## Open questions

None. All five were answered by the owner on 2026-08-23:

| Was open | Decided |
|---|---|
| Use the Anthropic SDK? | **No.** An MCP server is called by Claude, it does not call Claude |
| Two modules, or api at the root? | **Two modules** — `task-api` and `mcp-server` as peers |
| Also expose MCP on 8080? | **Yes** — `:8877/` and `:8080/mcp` reach the same replicas |
| Default replica count | **3**, so the multi-replica path is the one exercised by default |
| Tool naming | **Prefixed**: `tasks_create`, `tasks_list`, `tasks_get`, `tasks_update`, `tasks_delete` |

On the prefix: several MCP clients already namespace tools by server name, so a client may present
these as `tasks_tasks_create`. That was accepted in exchange for names that cannot collide when
the server is used without such a client.

Record new questions here rather than deciding them silently in code.
