# Quality

How correctness is established in this repo — the answer to "am I done?".

**Verified 2026-08-23** by running every command below against the implemented service. Where a
category genuinely does not exist here, it says so rather than inventing a command.

## Gate commands

**`make` is the entry point for everything in this repo.** Run it with no arguments for the
generated list. The Gradle and Docker commands underneath are shown here so the mapping is visible,
but prefer the make target — it is what the Makefile keeps correct.

Everything runs from the repository root. The Gradle wrapper is pinned to **Gradle 9.7.1** and the
daemon to **Java 25** (`gradle/gradle-daemon-jvm.properties`). Do not use a system `gradle` — it may
run on the wrong JVM, and the Micronaut plugin 5.x refuses anything below JVM 25.

| Gate | Make target | Underneath | Proves |
|---|---|---|---|
| Help | `make` | — | Lists every target. Builds nothing |
| Build | `make build` | `./gradlew build` | Compiles, runs annotation processors, runs all tests, assembles |
| Test (all) | `make test` | `./gradlew test` | All **32** tests pass (23 api + 9 mcp) |
| Test (one) | `make test-one TEST='*TimestampsTest*'` | `./gradlew test --tests …` | One class or method |
| Run (host) | `make run` | `./gradlew :task-api:run` | Task API on `:8080`, database at `data/tasks.db` |
| Run MCP (host) | `make run-mcp` | `./gradlew :mcp-server:run` | MCP server on `:8877`; needs `make run` in another shell |
| Clean | `make clean` | `./gradlew clean` | Discards `build/`. Leaves the database alone |
| Image | `make docker-build` | two `docker build` calls | Builds `tasks` and `tasks-mcp` (Java 25 runtime) |
| Run (Docker) | `make up` | `docker compose up --build -d --scale mcp=3` | nginx on `:8080` and `:8877`; api + 3 MCP replicas, all healthy |
| Scale | `make scale REPLICAS=n` | `docker compose up -d --scale mcp=n` | Changes the MCP replica count. The api cannot be scaled |
| Logs (mcp) | `make logs-mcp` | `docker compose logs -f mcp` | All MCP replicas |
| Stop | `make down` | `docker compose down` | Stops both. `./data` survives |
| Status | `make ps` | `docker compose ps` | Container state **and health**, both services |
| Logs (all) | `make logs` | `docker compose logs -f` | Both services, interleaved by time |
| Logs (api) | `make logs-api` | `docker compose logs -f api` | Application only |
| Logs (nginx) | `make logs-nginx` | `docker compose logs -f nginx` | Access log with upstream timing |
| Reload proxy | `make nginx-reload` | `nginx -t && nginx -s reload` | Validates first; a broken config never reaches the running server |
| Shell | `make shell` | `docker compose exec api /bin/bash` | Inside the running api container |
| DB shell | `make db-shell` | `sqlite3 data/tasks.db` | Reads the database directly |
| DB reset | `make db-reset` | `rm -f data/tasks.db*` | **Destructive.** Prompts first |

Overridable: `PORT=9000 make up`, `IMAGE=… TAG=… make docker-build`.

**Typecheck** is not a separate gate: `javac` runs as part of `compileJava`, and Micronaut's
annotation processors generate the repository implementation and bean definitions at that point. A
compile failure *is* the typecheck failure — including Micronaut Data errors about entity mapping,
which surface at compile time rather than at first query.

**In Docker, `:8080` is nginx, not the application.** The api container publishes no host port —
it is reachable only through the proxy. `make run` (no Docker) still binds the app directly, so
that is the one path that bypasses nginx.

**There is no runnable jar.** `java -jar build/libs/…` fails for both jars this project produces —
see *No self-contained jar* in [ARCHITECTURE.md](ARCHITECTURE.md#decisions--constraints). Use
`make run`, `make up`, or `./gradlew installDist`.

### Categories this repo genuinely lacks

| Missing | Notes |
|---|---|
| Lint | No Checkstyle, PMD, SpotBugs, or ErrorProne configured |
| Format | No Spotless or google-java-format. Formatting is by convention only |
| Coverage | No JaCoCo. There is no coverage number for this project |
| CI | No `.github/workflows/`, no pipeline. Gates run locally only |
| API docs | No OpenAPI/Swagger generation (`micronaut-openapi` is not on the classpath) |
| Image scanning | No Trivy/Grype step. Base images are digest-pinned but never scanned |

There are deliberately **no `make lint` / `make fmt` targets**: a target that does nothing is worse
than a missing one. Adding any of these is a real change, not a config tweak — do not claim a gate
exists until its command runs.

## Test layout & conventions

```
src/test/java/dev/petrov/tasks/
  TaskControllerTest.java   task-api obligations 1-16, real HTTP against a real SQLite file
  PersistenceTest.java      task-api obligations 17-19, across full application restarts
  TimestampsTest.java       timestamp format and monotonicity, with a frozen Clock
  HealthTest.java           docker-and-make obligation 17: /health returns UP

mcp-server/src/test/java/dev/petrov/tasks/mcp/
  McpServerTest.java        mcp-server obligations 1-8, over real HTTP
  StubTasksApi.java         a stand-in task API served from the same test context
```

**32 tests total** — 23 for the api, 9 for the MCP server.

**Naming.** Each test in `TaskControllerTest` carries a `@DisplayName` starting with the number of
the correctness obligation it proves in [`specs/task-api.md`](specs/task-api.md). That mapping is
the point: a failing test names the obligation that broke. Keep it when adding tests.

**No in-memory substitute.** Tests run against a real SQLite file in a JUnit `@TempDir`, not H2.
Several obligations are about SQLite and Flyway specifically; a different engine would pass them
without proving anything.

**No `@MicronautTest`.** The HTTP tests start an `EmbeddedServer` by hand via
`ApplicationContext.run(...)` so the datasource URL can point at a per-class temp file.
`PersistenceTest` goes further and starts and stops two whole contexts against the same file —
a single context would pass even if the data never reached disk, which is the exact failure being
guarded against.

**Isolation.** `TaskControllerTest` empties the table in `@BeforeEach` via the repository bean.
Tests do not depend on each other's data or on execution order.

**Mocking boundary: none.** Nothing is mocked. The service talks to a real repository against a
real database, and the tests talk to a real HTTP server. The only injected seam is `Clock`
(`ClockFactory`), so `TimestampsTest` can freeze time — that is a deliberate seam, not a mock.

## Definition of done

A change ships when:

- [ ] `make build` passes from a clean checkout.
- [ ] Every new behaviour has a test, and every changed behaviour has its existing test updated
      rather than deleted.
- [ ] If the change alters an API contract, the matching **correctness obligation** in
      [`specs/task-api.md`](specs/task-api.md) is updated in the same commit — spec and tests move
      together or they drift.
- [ ] A schema change is a **new** `V<n>__*.sql` migration. Never edit an applied migration:
      Flyway checksums them and an edited file breaks every existing database.
- [ ] `tasks.db` is not staged. It is in `.gitignore`; confirm with `git status`.
- [ ] Manual check for anything touching HTTP behaviour: `make run`, then exercise the endpoint
      with `curl`. The tests use Micronaut's client, which is more forgiving than curl about some
      header and encoding details.
- [ ] Anything touching packaging, config or the database path: `make up` and confirm `make ps`
      reports **healthy**, not merely `Up`. The container exercises a different code path than
      `make run` — it is where the missing-dependencies packaging bug surfaced.
- [ ] `data/` is not staged. Confirm with `git status`.

## Known gaps

The most useful part of this file. Current, honest state:

1. **No concurrency testing whatsoever.** `maximum-pool-size: 1` means the app serializes database
   access, and nothing verifies behaviour under parallel requests. Raising that pool size without
   adding tests would be a real risk — SQLite takes one writer.
2. **No test for a second process against the same file.** The design assumes one process. Nothing
   enforces or checks it, and SQLite will not stop you.
3. **No load, timeout, or large-payload testing.** `GET /tasks` returns every row with no
   pagination; behaviour at 100k tasks is unknown and untested.
4. **The 400 responses for validation are Micronaut's defaults, not ours.** Tests assert the status
   code and that no stack trace leaks, but the body shape is whatever the framework produces and
   could change under a framework upgrade. Only the 404 body is ours (`ApiError`).
5. **No coverage measurement.** The 23 tests map to stated obligations in [[task-api]] and
   [[docker-and-make]]; that is deliberate coverage of the *specs*, not measured coverage of the
   *code*. Untested branches may exist.
6. **No CI.** Every gate depends on a human running it locally.
7. **Flyway's SQLite support is inside `flyway-core`** rather than a dedicated module, and it is
   community-tier. It works here, verified by `PersistenceTest`, but it is not the path Redgate
   tests most heavily.
8. **The container has never been run on Linux.** Obligation 7 of [[docker-and-make]] — a non-root
   container writing to a bind-mounted host directory — passes on macOS only because Docker
   Desktop's file sharing remaps ownership. On Linux this can be `permission denied` on first
   write. Treat the container as unverified on Linux until someone runs `make up` there.
9. **Nothing tests the Makefile, Docker or nginx automatically.** Those obligations were checked by
   hand once, on 2026-08-23. A change to `Dockerfile`, `compose.yaml`, `nginx/nginx.conf` or
   `Makefile` has no safety net beyond running it. The 23 JUnit tests talk to the application
   directly and would stay green with the proxy completely broken.
10. **No real MCP client has connected.** The protocol was exercised with curl and from the test
    suite, which proves transport and tool contracts but not integration — a client may differ on
    session headers, `Accept` negotiation or protocol version. See [[mcp-server]] obligation 4.
11. **Nothing tests nginx's `/mcp` route on 8080 automatically.** Two entrances to one backend
    means two paths to keep in step, and only one of them is covered by a checked-in test.
12. **No image scanning.** Base images are digest-pinned, which means CVE fixes require a
    deliberate edit and nothing currently tells you when one is due.
13. **The api fronts one backend and cannot front more.** Not a bug — SQLite takes one writer. The
    guard is `container_name: tasks-api`, which makes `--scale api` fail. If anyone removes it, the
    refusal disappears silently and two writers hit one file. The **mcp** service deliberately has
    no such line. See [[nginx-load-balancer]] and [[mcp-server]].
14. **Rate limiting is wired but effectively off** at `100r/s` / burst 200. The mechanism is
    verified; the number is not tuned to anything real.
