# Task API

**Status:** shipped
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-23

> **Shipped 2026-08-23.** Implemented as specified; all 19 correctness obligations have a passing
> test. Paths below are real. Three things the implementation forced that the plan did not
> anticipate are recorded in [Implementation notes](#implementation-notes) — the spec text above
> them has been corrected to match the code, not left describing the plan.

## Problem

There is no way to keep track of tasks. A user needs to record a task, look at everything they have
recorded, pull up one task by id, change it as the work moves along, and remove it when it is no
longer relevant.

Scope is deliberately small: a locally-run HTTP service backed by a file on disk. Not a hosted
product, not multi-user.

## Scope

Five HTTP endpoints over a single `Task` resource:

| # | Method | Path | Purpose | Success |
|---|---|---|---|---|
| 1 | `POST` | `/tasks` | Create a task | `201 Created` + `Location` header + body |
| 2 | `GET` | `/tasks` | List all tasks | `200 OK` + array |
| 3 | `GET` | `/tasks/{id}` | Fetch one task by id | `200 OK` + object |
| 4 | `PUT` | `/tasks/{id}` | Edit a task | `200 OK` + updated object |
| 5 | `DELETE` | `/tasks/{id}` | Delete a task | `204 No Content` (idempotent) |

Also in scope:
- SQLite persistence in a file on disk, surviving restart.
- Schema creation on startup via a migration tool, not hand-run SQL.
- Request validation with meaningful `400` bodies.
- Runs locally with a single command.

**Non-goals:**
- Authentication, authorization, users, ownership. Every caller sees every task.
- Pagination, filtering, sorting, or search on the list endpoint — it returns everything.
- `PATCH` / partial update. `PUT` is a full replace (see [Design](#design)).
- Due dates, reminders, or anything time-scheduled. Tasks carry a priority, not a deadline.
- Sorting or filtering by priority. The field is stored and returned; ordering is the client's job
  (this follows from the no-pagination/no-sorting line above, but priority is the field most likely
  to tempt someone into adding it).
- Soft delete, audit history, or undo.
- Deployment, containerization, CI, or any hosted environment.
- A UI of any kind.
- Multi-instance / concurrent-writer operation. SQLite in this setup assumes one process.

## Design

### Stack

| Choice | Value | Note |
|---|---|---|
| Language | Java 21 (LTS) | Confirmed 2026-08-23. Constrains the framework major — see below |
| Framework | Micronaut **4.10.17** | Pinned 2026-08-23. Latest 4.x. See the version note below |
| Build | Gradle, Kotlin DSL (`build.gradle.kts`) | Confirmed 2026-08-23 |
| Persistence | Micronaut Data JDBC | Compile-time repositories; no runtime reflection/proxies |
| Driver | `org.xerial:sqlite-jdbc` | |
| Migrations | Flyway via `micronaut-flyway` | Confirmed 2026-08-23 |
| Validation | `micronaut-validation` (Jakarta Bean Validation) | |
| Tests | JUnit 5 + `@MicronautTest` + Micronaut HTTP client | |

#### Why Micronaut 4.10.17 and not 5.x

Micronaut **5** is the current release line (5.1.1, 2026-08-17) and Maven Central resolves `latest`
to it. This project pins **4.10.17** (2026-07-08, the newest 4.x) instead, deliberately.

Micronaut 5 has a **JDK 25 baseline** — its own guide states it outright. Java 21 was chosen for
this project, so Micronaut 5 is not an option without reopening that decision. Micronaut 4 requires
JDK 17+ and its 4.10 documentation demonstrates on Java 21, so 4.10.17 is the correct, supported
pairing.

The 4.10.x line is still receiving releases (4.10.15/16/17 all shipped in mid-2026), so this is a
maintained branch, not an abandoned one. Anyone who later wants Micronaut 5 must move the toolchain
to Java 25 first; the two decisions move together and neither can change alone.

Micronaut Data **JDBC**, not JPA/Hibernate: repositories are generated at compile time, which keeps
startup fast and avoids pulling Hibernate in for what is five CRUD operations.

### Layout

As built:

```
build.gradle.kts              Micronaut plugin 4.6.2, Java 21 toolchain
gradle.properties             micronautVersion=4.10.17 (pinned)
settings.gradle.kts
src/main/java/dev/petrov/tasks/
  Application.java              Micronaut entry point
  TaskController.java           the five endpoints; HTTP concerns only
  TaskService.java              business rules, not-found handling, timestamps
  TaskRepository.java           @JdbcRepository interface — Micronaut Data generates the impl
  Timestamps.java               the only reader of the clock
  ClockFactory.java             Clock bean, so tests can freeze time
  domain/Task.java              @MappedEntity — the persisted row
  domain/TaskStatus.java        enum + DEFAULT
  domain/TaskPriority.java      enum + DEFAULT
  dto/CreateTaskRequest.java    validated input for POST
  dto/UpdateTaskRequest.java    validated input for PUT
  dto/TaskResponse.java         what goes out over the wire
  error/NotFoundException.java
  error/ApiError.java           the JSON error body
  error/NotFoundExceptionHandler.java
src/main/resources/
  application.yml
  logback.xml
  db/migration/V1__create_tasks.sql
src/test/java/dev/petrov/tasks/
  TaskControllerTest.java       obligations 1-16, real HTTP + real SQLite
  PersistenceTest.java          obligations 17-19, across full restarts
  TimestampsTest.java           timestamp format and monotonicity
```

Two departures from the planned layout: `TaskServiceTest` was not written — the service has no
logic that the endpoint tests do not already exercise, and a unit test over the same paths would
duplicate rather than add. `GlobalExceptionHandler` became `NotFoundExceptionHandler`: only the 404
body is ours, because Micronaut's default handlers already return 400 with no stack trace for
validation and malformed JSON (obligations 1-5 confirm this).

The DTO layer is deliberate rather than returning the entity directly: it keeps `PUT` from being
able to overwrite `id` or `createdAt` just because the client sent them.

### Data model

`V1__create_tasks.sql`:

```sql
CREATE TABLE tasks (
    id          TEXT PRIMARY KEY,
    title       TEXT    NOT NULL,
    description TEXT,
    status      TEXT    NOT NULL DEFAULT 'TODO',
    priority    TEXT    NOT NULL DEFAULT 'MEDIUM',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
```

| Field | Type | Rules |
|---|---|---|
| `id` | UUID string | Server-generated. A client-supplied `id` is ignored, never honoured. |
| `title` | string | Required. `@NotBlank`, max 200 chars. |
| `description` | string | Optional, nullable, max 2000 chars. |
| `status` | enum | One of `TODO`, `IN_PROGRESS`, `DONE`. Defaults to `TODO` on create. |
| `priority` | enum | One of `LOW`, `MEDIUM`, `HIGH`. Defaults to `MEDIUM` on create. Confirmed 2026-08-23. |
| `created_at` | ISO-8601 UTC | Set once on insert, immutable thereafter. |
| `updated_at` | ISO-8601 UTC | Rewritten on every successful update. |

`priority` as a three-value enum stored as TEXT, mirroring `status`, rather than an integer rank:
an integer invites "is 1 highest or lowest?" and leaves room for meaningless values like 47. There
is deliberately **no due date** — see Non-goals.

UUID over an autoincrement integer: ids stay stable and non-guessable, and there is no dependency
on SQLite's `rowid` semantics.

Timestamps as ISO-8601 **TEXT**, not INTEGER epoch: SQLite has no native date type either way, and
text is readable when someone opens the file with the `sqlite3` CLI to debug.

### Flow — `POST /tasks`

The representative path, once written:

1. `TaskController.create(...)` receives `CreateTaskRequest`; `@Valid` rejects a blank title before
   any code of ours runs.
2. `TaskService.create(...)` generates the UUID, stamps `createdAt` == `updatedAt`, defaults status
   to `TODO` and priority to `MEDIUM` when absent.
3. `TaskRepository.save(...)` — the Micronaut-Data-generated `INSERT`.
4. Controller returns `201` with `Location: /tasks/{id}` and the `TaskResponse` body.

`GET`/`PUT`/`DELETE` follow the same three layers; the service throws `NotFoundException` when the
id is absent and `GlobalExceptionHandler` turns that into a `404` JSON body.

### PUT semantics

`PUT` is a **full replace** of the mutable fields. Omitting `description` clears it; it does not
leave the old value in place. This is what `PUT` means, and it removes the "was this omitted or
explicitly nulled?" ambiguity that a partial update would introduce. If partial update is wanted
later it arrives as a separate `PATCH` endpoint, not by loosening `PUT`.

### DELETE semantics

`DELETE` is **idempotent**: always `204 No Content`, whether or not the task existed (decided
2026-08-23). This is what HTTP says `DELETE` means, and it makes retries safe — a client that times
out and retries gets the same answer instead of a spurious `404`.

The cost is that a typo'd id is indistinguishable from a successful delete. That is accepted; a
caller who needs to know whether the task was there can `GET` it first.

### Configuration

`application.yml` — no secrets involved, this service has none:

| Key | Purpose | Default |
|---|---|---|
| `datasources.default.url` | SQLite JDBC URL | `jdbc:sqlite:tasks.db` — `tasks.db` at repo root |
| `micronaut.server.port` | Listen port | `8080` |
| `flyway.datasources.default.enabled` | Run migrations at startup | `true` |

The database file is **`tasks.db` at the repository root** (decided 2026-08-23) — no `data/`
subdirectory. The relative JDBC URL means the file lands wherever the process is started from, so
`./gradlew run` from the repo root is the supported way to run it.

**Required at scaffold time:** create a `.gitignore` containing `tasks.db` (plus the SQLite sidecar
files `tasks.db-shm` and `tasks.db-wal`). The database must never be committed. This project is not
currently a git repository at all, so `git init` and the `.gitignore` are both part of the first
implementation change.

## Correctness obligations

Each of these is a test target.

**Validation**
1. `POST` with a missing, empty, or whitespace-only `title` → `400`, and nothing is written.
2. `POST`/`PUT` with a `status` outside the enum → `400`, not a silent coercion or a `500`.
3. `POST`/`PUT` with a `priority` outside the enum → `400`. Same rule, same handling as `status`.
4. `title` over 200 chars or `description` over 2000 chars → `400`.
5. A malformed JSON body → `400`, never a stack trace in the response.

**Identity**
6. A client-supplied `id` in a `POST` body is ignored; the server's UUID wins.
7. `PUT` cannot change `id` or `createdAt`. Sending them has no effect.

**Not found**
8. `GET` and `PUT` on an unknown id return `404` with a JSON body — not `500`, and not an empty
   `200`. (`DELETE` is the exception; see 16.)
9. `GET`/`PUT` with a syntactically invalid id (not a UUID) return `404`, not `500`. Ids are stored
   as TEXT and looked up as opaque strings, so a malformed id is a miss, not a parse error.

**Semantics**
10. `POST` returns `201` with a `Location` header that actually resolves via `GET`.
11. `GET /tasks` on an empty database returns `200` with `[]`, not `404` and not `null`.
12. `POST` without `status` stores `TODO`; `POST` without `priority` stores `MEDIUM`.
13. `PUT` clears `description` when the field is omitted (the full-replace rule above).
14. `PUT` with `priority` omitted resets it to `MEDIUM` — it does **not** preserve the existing
    value. This is the same full-replace rule as 13 and it is the one most likely to surprise a
    caller who thinks they are only editing the title. Test it explicitly.
15. `updatedAt` strictly advances on a successful `PUT`; `createdAt` is untouched.
16. **`DELETE` is idempotent.** It returns `204` with an empty body in every case: the task
    existed and was removed, the task was already deleted, or the id never existed at all —
    a malformed id included. A client can safely retry. Test all three cases; the already-deleted
    one is what an implementation naturally gets wrong by returning `404`.

**Persistence**
17. Data written before a restart is readable after it — the SQLite file is the real store, not an
    in-memory fallback that silently took over.
18. Flyway creates the schema on a first run against a non-existent database file.
19. A second startup against an existing file does not re-run V1 or wipe data.

## Verification

All verified 2026-08-23. See [`../QUALITY.md`](../QUALITY.md) for the full gate table.

| Gate | Command | Result |
|---|---|---|
| Build | `./gradlew build` | passing |
| Test (all) | `./gradlew test` | 22 tests, 0 failures |
| Single test | `./gradlew test --tests '*TimestampsTest*'` | passing |
| Run | `./gradlew run` | serves on `:8080`, creates `tasks.db` at repo root |

Tests proving the obligations:

- `TaskControllerTest` — obligations 1-16, one test each, `@DisplayName` prefixed with the
  obligation number. Driven through Micronaut's HTTP client against a real SQLite file in a JUnit
  `@TempDir`, not an in-memory H2 substitute.
- `PersistenceTest` — obligations 17-19. Starts and stops two whole application contexts against
  the same file; a single context would pass even if data never reached disk. Reads
  `flyway_schema_history` through a raw `DriverManager` connection, bypassing the application's
  DataSource, to confirm the history really is in the file.
- `TimestampsTest` — the fixed-width format and the monotonicity guarantee, with a frozen `Clock`.

Manual smoke, run against the live service:

```sh
./gradlew run   # in another shell
curl -s -X POST localhost:8080/tasks -H 'Content-Type: application/json' \
  -d '{"title":"first task"}'
curl -s localhost:8080/tasks
sqlite3 tasks.db "SELECT id, title, status, priority FROM tasks;"
```

## Implementation notes

Three things the implementation forced that the plan did not anticipate. Each was a real failure
first, not a preference.

**1. `description` needs `@Nullable` on the entity.** Micronaut Data refuses to construct a record
from a row with a null component unless annotated, and it fails at *read* time with a runtime
`DataAccessException` — `Null value read for non-null constructor argument`. Five tests failed with
a 500 before this was added. The insert succeeded fine; only reading the row back broke. Any future
nullable column needs the same annotation.

**2. There is no `Dialect.SQLITE`.** Micronaut Data offers MYSQL, POSTGRES, SQL_SERVER, ORACLE, H2
and ANSI. `Dialect.ANSI` is correct here and SQLite accepts the generated SQL.

**3. Micronaut 4 does not bundle a YAML parser.** `application.yml` is inert without an explicit
`runtimeOnly("org.yaml:snakeyaml")`. The build fails loudly with a clear message, so this costs
minutes rather than hours, but it is not discoverable from the config file itself.

Also worth knowing: Flyway's SQLite support lives **inside `flyway-core`** (verified in the 10.22.0
jar), not in a separate `flyway-database-*` module as it does for most engines. No extra dependency
is needed. `flyway-database-sqlite` does not exist on Maven Central; do not go looking for it.

## Open questions

None. Every decision is settled as of 2026-08-23 and recorded above:

| Was open | Resolved to |
|---|---|
| Java version | 21 LTS |
| Build tool / DSL | Gradle, Kotlin DSL |
| Migrations | Flyway |
| Priority values | `LOW` / `MEDIUM` / `HIGH`, default `MEDIUM` |
| Package name | `dev.petrov.tasks` |
| Database file location | `tasks.db` at repo root |
| Repeated `DELETE` | `204`, idempotent |
| Micronaut version | `4.10.17` (pinned; Java 21 rules out 5.x) |

This spec is ready to implement. Record new questions here as they come up rather than deciding
them silently in code.
