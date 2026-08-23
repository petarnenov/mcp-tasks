# Architecture

Written from the code as it stands on **2026-08-23**. Every path and line reference below was
checked against the working tree.

## What this system is

A single-user task list with an HTTP interface. You create tasks, list them, read one, replace one,
and delete one. Each task carries a title, optional free-text description, a workflow status, and a
priority — no due dates, no assignment, no accounts. It runs on one machine, stores everything in
one SQLite file next to the code, and is intended to be started, used, and stopped by the person
who owns the machine.

**On the name:** the directory is called `mcp-tutorial` and stays that way by the owner's decision
(2026-08-23). It is a historical name, not a description — this project has nothing to do with the
Model Context Protocol. Do not infer scope from it.

## Map

| Component | Path | Owns |
|---|---|---|
| Entry point | `src/main/java/dev/petrov/tasks/Application.java` | Boots Micronaut. Nothing else |
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
| Entry point | `Makefile` | The documented way to run anything here. `make` lists the targets |

Roughly 880 lines of Java including tests.

## Flow

`POST /tasks` end to end:

1. `TaskController.create` (`src/main/java/dev/petrov/tasks/TaskController.java:30`) receives the
   body as a `CreateTaskRequest`. `@Valid` rejects a blank or oversized title here, before any of
   our code runs — the controller never sees an invalid request.
2. `TaskService.create` (`src/main/java/dev/petrov/tasks/TaskService.java:30`) generates the UUID,
   asks `Timestamps` for one string used as both `createdAt` and `updatedAt`, and substitutes
   `TaskStatus.DEFAULT` / `TaskPriority.DEFAULT` for anything the client omitted.
3. `repository.save(task)` runs the `INSERT` that Micronaut Data generated at compile time from
   `TaskRepository` (`src/main/java/dev/petrov/tasks/TaskRepository.java:16`).
4. The controller returns `201` with `Location: /tasks/{id}`.

`GET`, `PUT` and `DELETE` follow the same three layers. `TaskService.get` and `.update` throw
`NotFoundException`, which `NotFoundExceptionHandler` turns into a `404` carrying an `ApiError`
body. `TaskService.delete` (`src/main/java/dev/petrov/tasks/TaskService.java:83`) throws nothing —
see Decisions.

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
| `PORT` | Host-side published port | `Makefile` / `compose.yaml`, defaults to 8080 |
| `IMAGE`, `TAG` | Image name and tag | `Makefile`, default `tasks:latest` |

## Decisions & constraints

The non-obvious choices, and why. These are the ones that look wrong without context.

**Micronaut 4.10.17, not 5.x.** Micronaut 5 has a JDK 25 baseline; this project targets Java 21, so
the 4.x line is required. The two move together — adopting Micronaut 5 means moving the toolchain
to Java 25 first. Pinned in `gradle.properties`.

**Gradle wrapper pinned to 8.14.5.** The Micronaut Gradle plugin 4.6.2 targets Gradle 8; plugin 5.x
is the Gradle 9 / JDK 25 generation. Use `./gradlew`, not a system `gradle`.

**`Dialect.ANSI`, not `SQLITE`** (`TaskRepository.java:15`). Micronaut Data has no SQLite dialect —
the enum offers MYSQL, POSTGRES, SQL_SERVER, ORACLE, H2 and ANSI. Plain ANSI SQL is what these CRUD
operations need, and SQLite accepts it. This is not an oversight to be "fixed".

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

**`runtimeOnly("org.yaml:snakeyaml")`** in `build.gradle.kts`. Micronaut 4 does not bundle a YAML
parser. Without it the build fails outright with a clear message, but the reason is not obvious.

**There is no self-contained jar.** Neither `tasks-<version>.jar` nor `tasks-<version>-runner.jar`
runs on its own — the runner jar's manifest Class-Path points at sibling `resources/` and `libs/`
directories that exist only under `build/docker/main/layers/`. `java -jar` on either fails with
`NoClassDefFoundError`. Use `make run`, or `./gradlew installDist` for a standalone launcher. The
container copies the layered layout for the same reason.

**Base images are pinned by digest** in the `Dockerfile`, not by tag. A floating tag means the same
Dockerfile produces a different image next month. The cost is that security patches need a
deliberate edit — which is the point: the upgrade shows up in a diff.

**Makefile shell flags go on `SHELL`, not `.SHELLFLAGS`.** GNU Make 3.81, which macOS ships,
ignores `.SHELLFLAGS` silently — a Makefile using it looks strict while letting failed pipes pass.
`SHELL := /bin/bash -o pipefail -e` works on both 3.81 and 4.x. Do not "modernize" this.
