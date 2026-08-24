# Architecture

Written from the code as it stands on **2026-08-24**. Every path and line reference below was
checked against the working tree.

## What this system is

Two services and a page, in **two languages**. A single-user task list with an HTTP interface,
written in Java on Micronaut 5; an MCP server that exposes it as tools so a model can use it from a
conversation, written in TypeScript on Node; and a browser MCP client at `:8080/mcp/client` for
looking at those tools by hand, also TypeScript. The client is static files — no process, no
container.

The split is not a preference. The MCP Java SDK tops out at the **2025-11-25** protocol revision
and the current one is **2026-07-28**; TypeScript is where that revision exists. The full
measurement is in [[mcp-server-typescript]] under *Why not Java*. The argument that made a second
language acceptable applies to `mcp-server` and **not** to `task-api`: the MCP server is a
stateless proxy with all its logic behind `TASKS_API_URL`, while the api owns the database.

The task list: You create tasks, list them, read one, replace one,
and delete one. Each task carries a title, optional free-text description, a workflow status, and a
priority — no due dates, no assignment, no accounts. It runs on one machine, stores everything in
one SQLite file next to the code, and is intended to be started, used, and stopped by the person
who owns the machine.

**On the name:** the directory is called `mcp-tutorial` and stays that way by the owner's decision
(2026-08-23). The Model Context Protocol half of that name is accurate — `mcp-server/` serves
protocol revision 2026-07-28 with five tools, two resources and two prompts, and `mcp-client/` is a
browser client for it. The *tutorial* half undersells what is here: a production-shaped CRUD API on
Micronaut 5, an nginx front door and a three-replica Compose stack are not tutorial material. Read
the Map below for scope rather than the directory name. On **GitHub** it is published as
[`petarnenov/mcp-tasks`](https://github.com/petarnenov/mcp-tasks) — a separate name from the local
directory, deliberately; see [[github-publish]].

*(Until 2026-08-24 this paragraph claimed the project had "nothing to do with the Model Context
Protocol". That was stale text from before `mcp-server/` landed and is contradicted by the rest of
this document and by four shipped specs.)*

## Map

| Component | Path | Owns |
|---|---|---|
| Entry point | `task-api/src/main/java/dev/petrov/tasks/Application.java` | Boots Micronaut. Nothing else |
| HTTP layer | `TaskController.java` | The five routes, status codes, `Location` header. No business rules |
| Business rules | `TaskService.java` | Id generation, defaults, full-replace semantics, not-found |
| Persistence | `TaskRepository.java` | An empty interface — Micronaut Data writes the SQL at compile time |
| Entity | `domain/Task.java` | The persisted row shape |
| Enums | `domain/TaskStatus.java`, `domain/TaskPriority.java` | Allowed values plus their `DEFAULT` |
| Wire types | `dto/` | `CreateTaskRequest`, `UpdateTaskRequest`, `TaskResponse` |
| Errors | `error/` | `NotFoundException`, its handler, and the `ApiError` body |
| Time | `Timestamps.java`, `ClockFactory.java` | The single source of timestamp strings |
| Schema | `src/main/resources/db/migration/V1__create_tasks.sql` | The `tasks` table |
| Config | `src/main/resources/application.yml` | Datasource, port, Flyway |
| Container | `Dockerfile`, `.dockerignore`, `compose.yaml` | Multi-stage image, digest-pinned bases, bind-mounted database |
| Front door | `nginx/nginx.conf` | The only published ports, 8080 and 8877. Both backends publish nothing |
| MCP tools | `mcp-server/src/tools.ts` | The five tools, their descriptions and argument schemas, and the error translation |
| MCP resources | `mcp-server/src/resources.ts` | `tasks://tasks` and `tasks://tasks/{id}`, read-only, plus id completion. Throws where `tools.ts` never does — see [[mcp-resources]] |
| MCP prompts | `mcp-server/src/prompts.ts` | `triage_tasks` and `plan_task`, each embedding the resource it talks about. Throws too, but never `ResourceNotFoundError` — see [[mcp-prompts]] |
| MCP assembly | `mcp-server/src/server.ts` | The per-request `McpServer` factory, and the declared capabilities. Exported as a factory on purpose — see Decisions |
| MCP HTTP | `mcp-server/src/http.ts` | The two routes, `/mcp` and `/health`. Split from the entry point so tests can bind an ephemeral port |
| MCP entry point | `mcp-server/src/index.ts` | Environment, `listen`, SIGTERM. Nothing else |
| Task API client | `mcp-server/src/tasks-client.ts` | `fetch` over the api, plus the duplicated wire types. Returns a result union, never throws |
| MCP container | `mcp-server/Dockerfile` | `node:24-alpine`, digest-pinned, multi-stage, non-root |
| Client page | `mcp-client/src/main.ts` | DOM wiring. The only file in that module allowed to touch `document` |
| Client logic | `mcp-client/src/{connection,schema-form,resources,prompts,log}.ts` | Negotiation and era reporting, JSON Schema to form model, the resource and prompt models with their error handling, the message log. No DOM, so all five are unit-testable — but only four have suites; `connection.ts` has no test file |
| Entry point | `Makefile` | The documented way to run anything here. `make` lists the targets |

Roughly 940 lines of Java (`task-api`) and 4,080 lines of TypeScript (`mcp-server` plus
`mcp-client`), all including tests.

## Flow

`POST /tasks` end to end:

1. `TaskController.create` (`src/main/java/dev/petrov/tasks/TaskController.java:30`) receives the
   body as a `CreateTaskRequest`. `@Valid` rejects a blank or oversized title here, before any of
   our code runs — the controller never sees an invalid request.
2. `TaskService.create` (`src/main/java/dev/petrov/tasks/TaskService.java:30`) generates the UUID,
   asks `Timestamps` for one string used as both `createdAt` and `updatedAt`, and substitutes
   `TaskStatus.DEFAULT` / `TaskPriority.DEFAULT` for anything the client omitted.
3. `repository.save(task)` runs the `INSERT` that Micronaut Data generated at compile time from
   `TaskRepository` (`src/main/java/dev/petrov/tasks/TaskRepository.java:15`).
4. The controller returns `201` with `Location: /tasks/{id}`.

`GET`, `PUT` and `DELETE` follow the same three layers. `TaskService.get` and `.update` throw
`NotFoundException`, which `NotFoundExceptionHandler` turns into a `404` carrying an `ApiError`
body. `TaskService.delete` (`src/main/java/dev/petrov/tasks/TaskService.java:83`) throws nothing —
see Decisions.

## The two services, and why only one scales

| | `api` | `mcp` |
|---|---|---|
| Owns state | yes — one SQLite file | **no** — forwards over HTTP |
| Replicas | exactly **1**, enforced by `container_name` | **3** by default, `make scale REPLICAS=n` |
| Published port | none — nginx owns 8080 | none — nginx owns 8877 and `8080/mcp` |

The asymmetry is the whole design. SQLite takes a single writer, so a second `api` replica is data
corruption rather than throughput; `container_name: tasks-api` makes `--scale api=2` fail outright
and is a **safety interlock, not cosmetics**. The MCP server holds nothing, so any replica can
answer any request.

That last property is structural rather than maintained. `createMcpHandler` takes a **factory** and
builds one `McpServer` per request, so there is no instance that could accumulate state between
requests. The 2026-07-28 revision is sessionless by design, which is why no `Mcp-Session-Id`
affinity is needed at the proxy.

**Scaling the MCP layer does not raise the ceiling.** More replicas accept more concurrent tool
calls, and they all funnel into one api with `maximum-pool-size: 1`. The bottleneck moves; it does
not disappear.

## Boundaries

- **The controller holds no business rules.** It maps HTTP to service calls and back. Defaults, id
  generation, and timestamps live in the service. Adding an `if` about task state to the controller
  is the wrong place.
- **The service never touches HTTP.** It takes and returns DTOs and throws domain exceptions. It
  has no `HttpResponse` import and must not gain one.
- **The entity never leaves the service.** `Task` is not returned from any controller method;
  everything crossing the wire is a `dto/` record. This is what stops a client from writing `id` or
  `createdAt` by including them in a request body — there is no field to bind them to.
- **Nothing writes SQL by hand** except the Flyway migrations. Queries come from Micronaut Data.
- **`Timestamps` is the only place that reads the clock.** No `Instant.now()` anywhere else; that
  is what keeps the format consistent and the monotonicity guarantee real.
- **The MCP server talks to the api over HTTP like any other client.** It does not share code,
  a database connection, or DTO classes with it — it cannot, being in another language, and the
  wire types in `mcp-server/src/tasks-client.ts` are deliberate duplicates. The boundary that used
  to be a convention is now enforced by the toolchain.
- **The MCP server has no persistence and must not gain any.** Everything it knows comes back from
  `TASKS_API_URL`. A cache, a session store or a local file would each individually break the
  replica model.
- **In Docker, nothing reaches either application except through nginx.** The `api` service publishes
  no host port; `${PORT:-8080}` belongs to nginx. `make run` (no Docker) still binds the app
  directly — that is the one path that bypasses the proxy, and it is a development convenience.

## State & data

All persistent state is one SQLite file, **`data/tasks.db`**, holding one table:

```sql
CREATE TABLE tasks (
    id          TEXT PRIMARY KEY,   -- server-assigned UUID string
    title       TEXT    NOT NULL,
    description TEXT,               -- nullable
    status      TEXT    NOT NULL DEFAULT 'TODO',
    priority    TEXT    NOT NULL DEFAULT 'MEDIUM',
    created_at  TEXT    NOT NULL,   -- ISO-8601 UTC, six fractional digits
    updated_at  TEXT    NOT NULL
);
```

Migrations live in `src/main/resources/db/migration/` and Flyway applies them at startup, tracking
them in a `flyway_schema_history` table it creates itself. There are no caches and no other stores.

`data/` is the same directory the container bind-mounts at `/data`, so `make run` and `make up`
share one database rather than quietly keeping two. The JDBC URL is relative, so run from the
repository root. `data/` is git-ignored and excluded from the Docker build context.

## External dependencies

**No services.** No third-party APIs, no outbound network calls, no scheduled jobs, no message
queues, no authentication provider. Docker is a packaging choice, not a dependency of the code.

**No secrets.** Nothing here needs a credential.

Environment variables, none of them required — all have working defaults in `application.yml`:

| Variable | Purpose | Used by |
|---|---|---|
| `DATASOURCES_DEFAULT_URL` | Overrides the SQLite JDBC URL | `compose.yaml` sets it to `jdbc:sqlite:/data/tasks.db` |
| `MICRONAUT_SERVER_PORT` | Overrides the listen port | available, not currently used |
| `PORT` | Host-side published port — **nginx's**, not the app's | `Makefile` / `compose.yaml`, defaults to 8080 |
| `MCP_PORT` | Host-side published MCP port — nginx's | `Makefile` / `compose.yaml`, defaults to 8877 |
| `IMAGE`, `TAG`, `MCP_IMAGE` | Image names and tag | `Makefile`, default `tasks:latest` / `tasks-mcp:latest` |
| `TASKS_API_URL` | Where the MCP server finds the api | `compose.yaml` sets `http://api:8080`; defaults to `http://localhost:8080` for `make run-mcp` |
| `REPLICAS` | MCP replica count | `Makefile`, defaults to 3 |

## Decisions & constraints

The non-obvious choices, and why. These are the ones that look wrong without context.

**Micronaut 5.1.1 on Java 25.** Migrated from Micronaut 4.10.17 / Java 21 on 2026-08-23; see
[[micronaut-5-migration]]. **Java 25 is not an independent preference** — Micronaut 5 has a JDK 25
baseline, so the language level is forced by the framework. The two move together in both
directions.

**The Gradle daemon itself runs on Java 25**, pinned by `gradle/gradle-daemon-jvm.properties`. The
Micronaut Gradle plugin 5.x requires the *build* JVM to be 25, not merely the toolchain, so
`languageVersion = JavaLanguageVersion.of(25)` alone is not enough. `settings.gradle.kts` applies
the **foojay resolver** so a machine without JDK 25 provisions one rather than failing.

**Gradle wrapper pinned to 9.7.1.** Plugin 5.x is the Gradle 9 generation. Use `./gradlew`, never a
system `gradle` — the system one may be on the wrong JVM.

**`Dialect.SQLITE`** (`TaskRepository.java`). This was `Dialect.ANSI` until 2026-08-23, because
Micronaut Data 4 genuinely had no SQLite dialect and ANSI was the correct workaround. Micronaut
Data 5 added one. The old justification is gone; do not reinstate ANSI thinking it is a fix.

**Timestamps are fixed-width ISO-8601 strings, not a temporal type.** SQLite has no native date
type, so something has to choose the encoding. Text stays readable when someone opens the file with
the `sqlite3` CLI, and forcing exactly six fractional digits means lexicographic string comparison
agrees with chronological order — so the column sorts and compares correctly as plain TEXT.

**`Timestamps.nextAfter` bumps by a microsecond when the clock has not moved**
(`src/main/java/dev/petrov/tasks/Timestamps.java:41`). Two updates inside the same microsecond would
otherwise leave `updatedAt` unchanged, making "updatedAt advances on every update" true only on
slow machines. The bump makes the guarantee hold always instead of depending on hardware speed.

**`PUT` is a full replace.** An omitted `description` clears it; an omitted `status` or `priority`
resets to the default. This is what `PUT` means, and it removes the "was this omitted or explicitly
nulled?" ambiguity. It does surprise callers who think they are editing only the title — that is a
known, accepted cost. Partial update, if ever wanted, arrives as a separate `PATCH`, never by
loosening `PUT`.

**`DELETE` is idempotent — always `204`**, even for an id that never existed or is malformed
(`TaskService.java:83`). Retries are safe. The cost is that a typo'd id is indistinguishable from a
successful delete; a caller who needs to know can `GET` first.

**`maximum-pool-size: 1`** in `application.yml`. SQLite takes a single writer. One connection
removes `SQLITE_BUSY` entirely rather than papering over contention with a busy-timeout. This is
also why the service is single-process by design — see the gaps in
[QUALITY.md](QUALITY.md#known-gaps).

**`description` is `@Nullable` on the entity** (`domain/Task.java`). Micronaut Data refuses to
construct a record from a row with a null component unless it is annotated, and the failure is a
runtime `DataAccessException` on read, not a compile error. If you add another nullable column,
annotate it.

**`runtimeOnly("org.yaml:snakeyaml")`** in `build.gradle.kts`. Neither Micronaut 4 nor 5 bundles a
YAML parser — re-checked on 2026-08-23 by removing it and watching the build fail. Without it the
failure is loud but the reason is not obvious.

**The runtime image installs `curl`.** `eclipse-temurin:25-jre` ships no `curl`, `wget` or `nc`;
the Java 21 image had curl and wget. The compose healthcheck probes `/health` over HTTP, so without
that `apt-get` line the container starts and simply never reports healthy. A TCP-only probe was
rejected: a JVM with an open socket and a broken datasource would pass it, which is the exact case
`/health` exists to catch.

**There is no self-contained jar.** Neither `task-api-<version>.jar` nor
`task-api-<version>-runner.jar` runs on its own, and they fail for different reasons. The plain jar
has no `Main-Class` at all, so `java -jar` answers *"no main manifest attribute"*. The runner jar
has one, but its manifest `Class-Path` names sibling `resources/`, `classes/` and `libs/`
directories that exist only under `task-api/build/docker/main/layers/` — run it from
`task-api/build/libs/` and it dies with `NoClassDefFoundError: io/micronaut/runtime/Micronaut`. Use
`make run`, or `./gradlew installDist` for a standalone launcher. The container copies the layered
layout for the same reason.

Both jars carried the `tasks-` prefix until the sources moved under `task-api/` in `1cc88ca`, and
this paragraph said so until 2026-08-24. Re-verified that day on **Java 25** — on an older JVM the
runner jar fails earlier still, with `UnsupportedClassVersionError`, which is a property of the
machine rather than of the packaging.

**Base images are pinned by digest** in the `Dockerfile`, not by tag. A floating tag means the same
Dockerfile produces a different image next month. The cost is that security patches need a
deliberate edit — which is the point: the upgrade shows up in a diff.

**Nginx proxies to one backend, and that is not an accident.** SQLite takes a single writer, so
replicas behind the proxy would mean two processes writing one file over a bind mount —
`SQLITE_BUSY` at best, corruption at worst. `container_name: tasks-api` in `compose.yaml` makes
`docker compose up --scale api=2` fail outright (verified: exit 1). That line is a **safety
interlock, not cosmetics** — removing it requires replacing SQLite first.

**`proxy_pass` goes through a variable, not a literal hostname** (`nginx/nginx.conf`). With a
literal, nginx resolves the backend once at startup and caches it forever, so a restarted `api`
container on a new IP produces 502s until nginx is reloaded. The variable plus `resolver
127.0.0.11 valid=10s` forces resolution per request. Verified by forcing the backend onto a new
address, not merely by restarting it.

**`/nginx-health` deliberately does not touch the backend.** It answers "is the proxy up"; the
app's `/health` answers "is the app up". One curl each then tells you which layer failed. Merging
them would make every backend restart look like a proxy outage.

**The MCP server is TypeScript because of a protocol version, not a preference.** The MCP Java SDK
(`io.modelcontextprotocol.sdk:mcp-core` 2.0.1, the latest release) implements up to **2025-11-25**;
the current spec revision is **2026-07-28**. `@modelcontextprotocol/server` 2.0.0 implements it.
The evidence is in [[mcp-server-typescript]] — do not reopen this from memory, the version table
there was built by unzipping the artifacts. **This does not license a second language elsewhere:**
`mcp-server` was a stateless proxy behind one environment variable. `task-api` owns the database.

**`createMcpHandler` is given a factory, and `server.ts` exports one.** One `McpServer` is built per
request and discarded. Returning a singleton would work in a single replica and quietly break the
scaling model, since state could then survive between requests. The factory shape is what makes
"any replica can answer any request" a consequence rather than a promise.

**`TasksClient` returns a result union instead of throwing.** `ApiResult<T>` is
`{ok:true,value}` | `{ok:false,kind:'status',status}` | `{ok:false,kind:'unreachable',detail}`. A 404
is a normal outcome of `tasks_get`, not an exception. The Java version treated it as one and had a
bug where a missing task came back as a cheerful success with a body of `"null"`; here the compiler
refuses to let a caller skip the failure arm.

**Every tool returns `isError: true` rather than throwing.** A thrown error reaches the model as an
opaque `-32603` with the message stripped — measured on the Java implementation, and the reason
that spec's first implementation note exists. JSON-RPC errors are for malformed requests; a tool
that ran and could not do the job hands the model text it can act on.

**The MCP container's healthcheck is `node -e "fetch(...)"`, not `curl`.** `node:24-alpine` ships no
curl, and installing one to make a request the runtime can already make would be a package added for
nothing. This is the same reasoning that made the *api* image install curl — a JRE cannot make an
HTTP request from the command line, and a Node runtime can.

**`ENTRYPOINT ["node", "dist/index.js"]`, never `npm start`.** npm as PID 1 does not forward
SIGTERM, so `make down` and every scale-down would wait out the kill timeout. `index.ts` installs
its own SIGTERM/SIGINT handler for the same reason.

**The browser client is static files behind the existing nginx, not a service.** It is served at
`/mcp/client`, which makes the MCP endpoint at `/mcp` **same-origin** — no CORS, no preflight, and
no relay backend. A client on its own port would have forced CORS headers onto the MCP server. The
`^~ /mcp/client` location wins over `/mcp` by longest prefix; that was measured, not assumed. See
[[mcp-client]].

**The client negotiates `'auto'` and shouts about a downgrade.** It prefers 2026-07-28 but connects
to a 2025-era server too, and renders anything below modern in a warning state naming the revision
it did not get. Pinning was the original design and was changed on 2026-08-23: a pinned client
cannot talk to an older server at all, and — measured — does not even fail fast, sitting through a
60-second probe timeout. The requirement is met by *preferring* the newest revision and making a
downgrade impossible to miss, which is the exact failure the MCP Inspector's default demonstrated.

**`absolute_redirect off` on the client location** (`nginx/nginx.conf`). nginx's directory redirect
for `/mcp/client` built its `Location` from its own listen port, so `PORT=9000 make up` sent the
browser to `:8080` where nothing listens. Relative redirects resolve against the origin the browser
is already on. Do not remove this thinking it is cosmetic.

**No `Host` or `Origin` guard on the MCP endpoint.** The SDK ships `localhostHostValidation()` and
`localhostOriginValidation()` for servers bound to loopback on a developer's machine. nginx rewrites
`Host`, so either would reject every proxied request. The omission is deliberate; the endpoint's
posture is unchanged from the Java server, which is to say there is none.

**Makefile shell flags go on `SHELL`, not `.SHELLFLAGS`.** GNU Make 3.81, which macOS ships,
ignores `.SHELLFLAGS` silently — a Makefile using it looks strict while letting failed pipes pass.
`SHELL := /bin/bash -o pipefail -e` works on both 3.81 and 4.x. Do not "modernize" this.
