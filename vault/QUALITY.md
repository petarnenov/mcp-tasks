# Quality

How correctness is established in this repo — the answer to "am I done?".

**Verified 2026-08-24.** The test and Docker gates were re-run end to end that day: `make test`
(113 tests, 0 failures), `make up` to a fully healthy stack, `make ps`, `make nginx-reload`, the
`--scale api=2` interlock, every endpoint in the table below, and a `tools/list` + `tasks_list` from
a real MCP client through nginx. `make build` was additionally proven **from a clean checkout** — a
fresh clone of the published repository with nothing carried over. The interactive and follow-mode
targets (`make shell`, `make logs*`, `make db-reset`, `make run-mcp-inspector`, `make test-one`) are
unchanged since the 2026-08-23 pass and were not re-run. Where a category genuinely does not exist
here, this file says so rather than inventing a command.

## Gate commands

**`make` is the entry point for everything in this repo.** Run it with no arguments for the
generated list. The Gradle and Docker commands underneath are shown here so the mapping is visible,
but prefer the make target — it is what the Makefile keeps correct.

Everything runs from the repository root. **There are three modules and two toolchains:**
`task-api` is Gradle/Java; `mcp-server` and `mcp-client` are npm/TypeScript. `make build` and
`make test` run all three; the `-api`, `-mcp` and `-client` targets run one.

The Gradle wrapper is pinned to **Gradle 9.7.1** and the daemon to **Java 25**
(`gradle/gradle-daemon-jvm.properties`). Do not use a system `gradle` — it may run on the wrong JVM,
and the Micronaut plugin 5.x refuses anything below JVM 25. Both TypeScript modules need **Node 24 or
newer** (`engines` in both `package.json` files); the container is pinned to Node 24 LTS.

| Gate | Make target | Underneath | Proves |
|---|---|---|---|
| Help | `make` | — | Lists every target. Builds nothing |
| Build | `make build` | `build-api` + `build-mcp` + `build-client` | All three modules compiled and tested |
| Build (api) | `make build-api` | `./gradlew build` | Compiles, runs annotation processors, runs the 23 api tests, assembles |
| Build (mcp) | `make build-mcp` | `npm ci && npm run build && npm test` | Typechecks, compiles to `mcp-server/dist`, runs the 40 mcp tests |
| Build (client) | `make build-client` | `npm ci && tsc && esbuild && npm test` | Typechecks, bundles to `mcp-client/dist`, runs the 50 client tests |
| Install | `make install` | `npm --prefix mcp-server ci` | Installs exactly what `package-lock.json` pins |
| Test (all) | `make test` | `test-api` + `test-mcp` + `test-client` | All **113** tests pass (23 api + 40 mcp + 50 client) |
| Test (api) | `make test-api` | `./gradlew test` | The 23 JUnit tests |
| Test (mcp) | `make test-mcp` | `npm --prefix mcp-server test` | The 40 vitest tests |
| Test (client) | `make test-client` | `npm --prefix mcp-client test` | The 50 vitest tests |
| Test (one) | `make test-one TEST='*TimestampsTest*'` | `./gradlew test --tests …` | One **api** class or method. There is no mcp equivalent; use `npx vitest -t '…'` |
| Run (host) | `make run` | `./gradlew :task-api:run` | Task API on `:8080`, database at `data/tasks.db` |
| Run MCP (host) | `make run-mcp` | `npm --prefix mcp-server run dev` | Compiles, then MCP server on `:8877`; needs `make run` in another shell |
| Inspector | `make run-mcp-inspector` | `npx -y @modelcontextprotocol/inspector@2.3.0` | Opens the MCP Inspector web UI. **Not a gate** — it runs the tool, not the server, and needs the server already up |
| Client | `make run-client` | opens `:8080/mcp/client` | Our own browser MCP client. **Not a gate.** Needs `make up`; unlike the Inspector it needs no protocol setting |
| Clean | `make clean` | `./gradlew clean && rm -rf mcp-server/dist mcp-client/dist` | Discards build output. Leaves the database and `node_modules` alone |
| Image | `make docker-build` | two `docker build` calls | Builds `tasks` (Java 25) and `tasks-mcp` (Node 24) |
| Run (Docker) | `make up` | `build-client`, then `docker compose up --build -d --scale mcp=3` | nginx on `:8080` and `:8877`; api + 3 MCP replicas, all healthy, client page mounted |
| Scale | `make scale REPLICAS=n` | `docker compose up -d --no-recreate --scale mcp=n` | Changes the MCP replica count without restarting what is already up. The api cannot be scaled — `--scale api=2` exits 1 |
| Logs (mcp) | `make logs-mcp` | `docker compose logs -f mcp` | All MCP replicas |
| Stop | `make down` | `docker compose down` | Stops all three services. `./data` survives |
| Status | `make ps` | `docker compose ps` | Container state **and health** for all three services — api, the mcp replicas, and nginx |
| Logs (all) | `make logs` | `docker compose logs -f` | Both services, interleaved by time |
| Logs (api) | `make logs-api` | `docker compose logs -f api` | Application only |
| Logs (nginx) | `make logs-nginx` | `docker compose logs -f nginx` | Access log with upstream timing |
| Reload proxy | `make nginx-reload` | `nginx -t && nginx -s reload` | Validates first; a broken config never reaches the running server |
| Shell | `make shell` | `docker compose exec api /bin/bash` | Inside the running api container |
| DB shell | `make db-shell` | `sqlite3 data/tasks.db` | Reads the database directly |
| DB reset | `make db-reset` | `rm -f data/tasks.db*` | **Destructive.** Prompts first |

Overridable: `PORT=9000 make up`, `IMAGE=… TAG=… make docker-build`,
`INSPECTOR=@modelcontextprotocol/inspector@latest make run-mcp-inspector`.

**The Inspector's Protocol Era defaults to Legacy.** `make run-mcp-inspector` prints a reminder,
because the default is `Legacy (2025-11-25 handshake)` — the Inspector's own reasoning is that a
debugging tool should not auto-probe. A connection therefore shows `LEGACY` and `MCP 2025-11-25`
until the era is switched to **Modern** or **Auto** in that server's Settings panel. That is the
Inspector's default, not this server's ceiling; see [[mcp-server-typescript]] obligation 14.

**Typecheck is not a separate gate in either service.** For `task-api`, `javac` runs as part of
`compileJava` and Micronaut's annotation processors generate the repository implementation and bean
definitions at that point — a compile failure *is* the typecheck failure, including Micronaut Data
errors about entity mapping, which surface at compile time rather than at first query. For
`mcp-server`, `npm run build` is `tsc`, so compiling and typechecking are the same command;
`npm run typecheck` (`tsc --noEmit`) exists for a check without emitting. For `mcp-client` they are
**not** the same: esbuild strips types without checking them, so `npm run build` runs `tsc --noEmit`
first and then bundles. Removing that step would let type errors ship.

**In Docker, `:8080` is nginx, not the application.** The api container publishes no host port —
it is reachable only through the proxy. `make run` (no Docker) still binds the app directly, so
that is the one path that bypasses nginx.

**There is no runnable jar.** `java -jar build/libs/…` fails for both jars this project produces —
see *No self-contained jar* in [ARCHITECTURE.md](ARCHITECTURE.md#decisions--constraints). Use
`make run`, `make up`, or `./gradlew installDist`.

### Categories this repo genuinely lacks

| Missing | Notes |
|---|---|
| Lint | No Checkstyle, PMD, SpotBugs or ErrorProne on the Java side; no ESLint on the TypeScript side |
| Format | No Spotless, google-java-format or Prettier. Formatting is by convention only |
| Coverage | No JaCoCo, and vitest's coverage reporter is not enabled. There is no coverage number for this project |
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

mcp-server/test/
  mcp-server.test.ts        mcp-server-typescript obligations 1-12, over real HTTP
  resources.test.ts         mcp-resources obligations 1-13, over real HTTP
  prompts.test.ts           mcp-prompts obligations 1-13 (and 7b), over real HTTP
  stub-tasks-api.ts         a stand-in task API on its own HTTP server

mcp-client/test/
  schema-form.test.ts       mcp-client obligations 5-7, against the server's real schemas
  log.test.ts               mcp-client obligations 9-11
  resources.test.ts         mcp-resources obligations 14-17
  prompts.test.ts           mcp-prompts obligations 14-17
```

**113 tests total** — 23 for the api (JUnit), 40 for the MCP server and 50 for the client (vitest).

**Naming.** Each test in `TaskControllerTest` carries a `@DisplayName` starting with the number of
the correctness obligation it proves in [`specs/task-api.md`](specs/task-api.md), and each test in
`mcp-server.test.ts` starts its name with the obligation number from
[`specs/mcp-server-typescript.md`](specs/mcp-server-typescript.md). That mapping is the point: a
failing test names the obligation that broke. Keep it when adding tests.

**One spec per test file, for that reason.** `resources.test.ts` in both modules numbers into
[`specs/mcp-resources.md`](specs/mcp-resources.md), and it is a separate file rather than more
tests in `mcp-server.test.ts` precisely so the numbers stay unambiguous. A new spec gets a new
file.

**The MCP tests drive a real MCP client.** `mcp-server.test.ts` connects with the SDK's own
`Client` over `StreamableHTTPClientTransport`, once pinned to the modern 2026-07-28 era and once on
the legacy default. This is what closes the obligation the Java implementation never could — it was
driven with curl, which proves the transport and not the integration. It also matters because era
classification depends on request shape: a hand-built `server/discover` POST without the `_meta`
envelope is routed to the legacy leg and answers `-32601`, which looks exactly like an unimplemented
method. Do not verify the protocol with curl alone.

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

**Mocking boundary: none, in either service.** Nothing is mocked. The api's service talks to a real
repository against a real database, and its tests talk to a real HTTP server. The MCP tests run a
real `TasksClient` against a real stub HTTP server (`stub-tasks-api.ts`) rather than substituting
the client — a mock at that boundary would skip the response-translation half, which is where the
Java implementation's not-found bug lived. The only injected seam anywhere is `Clock`
(`ClockFactory`), so `TimestampsTest` can freeze time — that is a deliberate seam, not a mock.

## Definition of done

A change ships when:

- [ ] `make build` passes from a clean checkout.
- [ ] Every new behaviour has a test, and every changed behaviour has its existing test updated
      rather than deleted.
- [ ] If the change alters an API contract, the matching **correctness obligation** in
      [`specs/task-api.md`](specs/task-api.md) — or
      [`specs/mcp-server-typescript.md`](specs/mcp-server-typescript.md) for the MCP side — is
      updated in the same commit. Spec and tests move together or they drift.
- [ ] A dependency change in `mcp-server` commits the updated `package-lock.json` too. The image
      installs with `npm ci`, which fails outright if the lockfile and the manifest disagree.
- [ ] A schema change is a **new** `V<n>__*.sql` migration. Never edit an applied migration:
      Flyway checksums them and an edited file breaks every existing database.
- [ ] `tasks.db` is not staged. It is in `.gitignore`; confirm with `git status`.
- [ ] Manual check for anything touching HTTP behaviour: `make run`, then exercise the endpoint
      with `curl`. The tests use Micronaut's client, which is more forgiving than curl about some
      header and encoding details.
- [ ] Anything touching packaging, config or the database path: `make up` and confirm `make ps`
      reports **healthy**, not merely `Up`. The container exercises a different code path than
      `make run` — it is where the missing-dependencies packaging bug surfaced.
- [ ] `data/` and `node_modules/` are not staged. Both are in `.gitignore`; confirm with
      `git status`.
- [ ] Anything touching the MCP protocol: verify with a **real MCP client**, not curl. See the note
      under *Test layout* — a hand-built request without the `_meta` envelope is classified legacy
      and answers `-32601`, which reads exactly like a missing feature.

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
5. **No coverage measurement.** The 113 tests map to stated obligations in [[task-api]],
   [[docker-and-make]], [[mcp-server-typescript]], [[mcp-resources]], [[mcp-prompts]] and
   [[mcp-client]]; that is deliberate coverage of the *specs*, not measured coverage of the *code*.
   Untested branches may exist.
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
   `Makefile` has no safety net beyond running it. Both test suites talk to their service
   directly and would stay green with the proxy completely broken.
10. **The MCP deployment obligations are still manual.** Obligations 13-20 of
    [[mcp-server-typescript]] — replica spread, failover, port override, both entrances, the
    Inspector — were checked by hand on 2026-08-23 and have no automated coverage. Obligations 1-12
    are the ones the vitest tests carry. Same shape for [[mcp-resources]]: its obligations 1-17 are
    automated, 18-20 (both entrances, the browser client, the Inspector) were checked by hand on
    2026-08-24, and [[mcp-prompts]] repeats the split exactly.
11. **Nothing tests nginx's `/mcp` route on 8080 automatically.** Two entrances to one backend
    means two paths to keep in step, and only one of them is covered by a checked-in test.
12. **No image scanning.** Base images are digest-pinned, which means CVE fixes require a
    deliberate edit and nothing currently tells you when one is due.
13. **The api fronts one backend and cannot front more.** Not a bug — SQLite takes one writer. The
    guard is `container_name: tasks-api`, which makes `--scale api` fail. If anyone removes it, the
    refusal disappears silently and two writers hit one file. The **mcp** service deliberately has
    no such line. See [[nginx-load-balancer]] and [[mcp-server-typescript]].
14. **Rate limiting is wired but effectively off** at `100r/s` / burst 200. The mechanism is
    verified; the number is not tuned to anything real.
15. **`legacy: 'stateless'` serving is barely covered.** One test connects a 2025-era client and
    lists tools. The legacy leg has its own transport and its own error paths, and a regression
    there would only show up against an old client — which is most of them today. See
    [[mcp-server-typescript]], *Both eras*.
16. **Two languages, one repository, no shared contract test.** Nothing stops `task-api` and
    `mcp-server` from drifting on the wire: the duplicated types in `tasks-client.ts` are checked
    against the stub, not against the real api. A response-shape change in the api would pass both
    suites and fail only under `make up`.
17. **No browser test runner.** `mcp-client`'s DOM layer — `main.ts`, roughly a third of the
    module — has **no automated coverage at all**. Obligations 1-4 and 10-16 of [[mcp-client]] were
    driven by hand through a real browser on 2026-08-23 and will not be re-run by anything. The
    logic worth testing was deliberately kept out of `main.ts` for this reason, but "deliberately
    thin" is not "verified" — and the extraction is not complete: `connection.ts` (197 lines, no
    DOM) is the one file in `mcp-client/src/` with neither a test file nor a suite importing it, so
    negotiation and the downgrade path have no checked-in coverage despite being unit-testable
    today, without a browser runner. Adding Playwright was considered and declined; it is the
    decision to revisit first if the page grows.
18. **`mcp-client/dist` is a bind mount, so a stale bundle is invisible.** `make up` depends on
    `build-client`, which closes the common case, but editing `src/` and refreshing the browser
    without rebuilding shows the old page with no warning anywhere.
19. **The client's dependency tree is one npm bug away from an unbuildable image.** vitest's nested
    esbuild and the direct one must stay on the same version, or `npm ci` fails with
    `EBADPLATFORM` — see implementation note 4 in [[mcp-client]]. Nothing enforces the alignment.
