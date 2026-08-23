# Quality

How correctness is established in this repo — the answer to "am I done?".

**Verified 2026-08-23** by running every command below against the implemented service. Where a
category genuinely does not exist here, it says so rather than inventing a command.

## Gate commands

All commands run from the repository root, through the Gradle wrapper (`gradlew`, pinned to
**Gradle 8.14.5**). Do not use a system `gradle` — the local one is 9.4.1, and the Micronaut Gradle
plugin 4.6.2 that this project uses targets the Gradle 8 line.

| Gate | Command | Proves |
|---|---|---|
| Build | `./gradlew build` | Compiles, runs annotation processors, runs all tests, assembles the jar |
| Test (all) | `./gradlew test` | All 22 tests pass |
| Test (single class) | `./gradlew test --tests '*TimestampsTest*'` | One class in isolation |
| Test (single method) | `./gradlew test --tests '*TaskControllerTest.deleteIsIdempotent'` | One test |
| Run | `./gradlew run` | Service on `http://localhost:8080`, `tasks.db` created at repo root |
| Clean | `./gradlew clean` | Discards `build/` |

**Typecheck** is not a separate gate: `javac` runs as part of `compileJava`, and Micronaut's
annotation processors generate the repository implementation and bean definitions at that point.
A compile failure *is* the typecheck failure — including Micronaut Data errors about entity
mapping, which surface at compile time rather than at first query.

### Categories this repo genuinely lacks

| Missing | Notes |
|---|---|
| Lint | No Checkstyle, PMD, SpotBugs, or ErrorProne configured |
| Format | No Spotless or google-java-format. Formatting is by convention only |
| Coverage | No JaCoCo. There is no coverage number for this project |
| CI | No `.github/workflows/`, no pipeline. Gates run locally only |
| API docs | No OpenAPI/Swagger generation (`micronaut-openapi` is not on the classpath) |

Adding any of these is a real change, not a config tweak — do not claim a gate exists until its
command runs.

## Test layout & conventions

```
src/test/java/dev/petrov/tasks/
  TaskControllerTest.java   obligations 1-16, over real HTTP against a real SQLite file
  PersistenceTest.java      obligations 17-19, across full application restarts
  TimestampsTest.java       unit tests for the timestamp format and monotonicity
```

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

- [ ] `./gradlew build` passes from a clean checkout.
- [ ] Every new behaviour has a test, and every changed behaviour has its existing test updated
      rather than deleted.
- [ ] If the change alters an API contract, the matching **correctness obligation** in
      [`specs/task-api.md`](specs/task-api.md) is updated in the same commit — spec and tests move
      together or they drift.
- [ ] A schema change is a **new** `V<n>__*.sql` migration. Never edit an applied migration:
      Flyway checksums them and an edited file breaks every existing database.
- [ ] `tasks.db` is not staged. It is in `.gitignore`; confirm with `git status`.
- [ ] Manual check for anything touching HTTP behaviour: `./gradlew run`, then exercise the
      endpoint with `curl`. The tests use Micronaut's client, which is more forgiving than curl
      about some header and encoding details.

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
5. **No coverage measurement.** The 22 tests map to 19 stated obligations; that is deliberate
   coverage of the *spec*, not measured coverage of the *code*. Untested branches may exist.
6. **No CI.** Every gate depends on a human running it locally.
7. **Flyway's SQLite support is inside `flyway-core`** rather than a dedicated module, and it is
   community-tier. It works here, verified by `PersistenceTest`, but it is not the path Redgate
   tests most heavily.
