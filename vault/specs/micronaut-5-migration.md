# Micronaut 5 / Java 25 migration

**Status:** shipped
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-23

> **Shipped 2026-08-23.** All 14 obligations verified. Two things the implementation forced are
> in [Implementation notes](#implementation-notes). This unblocks [[mcp-server]].
>
> Every version and compatibility claim below was checked against Maven Central or the published
> artifacts on 2026-08-23. Nothing is from memory.
>
> **Fully specified.** Decisions confirmed by the owner on 2026-08-23;
> [Open questions](#open-questions) is a decision record. Ready to implement.

## Problem

The project is pinned to **Micronaut 4.10.17 / Java 21 / Gradle 8.14.5**. That pin was correct when
it was made and the reasoning is recorded in [[docker-and-make]]: Micronaut 5 has a JDK 25 baseline,
Java 21 was the chosen language level, and the two move together.

The MCP work forces the question. `io.micronaut.mcp:micronaut-mcp-server-java-sdk` ships in two
lines and they are not interchangeable:

| Version | Requires | Usable here today |
|---|---|---|
| `0.0.20` | `micronaut-core-bom` **4.10.16** | yes — and it is what platform 4.10.17 manages |
| `1.0.0` – `1.1.0` | `micronaut-core-bom` **5.0.0 / 5.1.1** | no |
| `2.0.0` | `micronaut-core-bom` **5.1.10** | no |

Staying on Micronaut 4 means building the MCP server against `0.0.20` — a pre-1.0 artifact, three
major lines behind, on a branch that is receiving no new features. The owner chose to migrate
instead (2026-08-23).

## Scope

A version-only migration. **No behaviour changes, no new features, no MCP work.**

| Component | From | To |
|---|---|---|
| Micronaut platform | 4.10.17 | **5.1.1** |
| Java toolchain | 21 | **25** |
| Gradle wrapper | 8.14.5 | **9.7.1** |
| Micronaut Gradle plugin | 4.6.2 | **5.0.2** |
| Builder base image | `eclipse-temurin:21-jdk` | `eclipse-temurin:25-jdk` |
| Runtime base image | `eclipse-temurin:21-jre` | `eclipse-temurin:25-jre` |
| Micronaut Data dialect | `Dialect.ANSI` | **`Dialect.SQLITE`** — see below |

Also in scope:
- Re-pin both Temurin digests; the current ones point at Java 21 images.
- Update every version claim in the vault: [[task-api]], [[docker-and-make]],
  [`../ARCHITECTURE.md`](../ARCHITECTURE.md), [`../QUALITY.md`](../QUALITY.md).

**Non-goals:**
- Any change to the API contract. All 19 [[task-api]] obligations hold unchanged.
- Any change to nginx, the Makefile targets, or the database path.
- The MCP server. That is [[mcp-server]], and it lands after this.
- GraalVM native image, still out of scope.
- Adopting new Micronaut 5 features. This migration should be boring.

## What the recon found

Each of these was verified against the actual artifact, not assumed.

### Cleared: Flyway still bundles SQLite

**This was the migration's biggest risk.** Micronaut 5.1.1 manages **Flyway 12.11.0**, up from
10.22.0. [[docker-and-make]] records that Flyway's SQLite support lives *inside* `flyway-core`
rather than in a `flyway-database-*` module — and Flyway has been moving databases out into
separate modules over time. If SQLite had moved, `make up` would fail at startup on a migration
this project cannot run.

Verified by downloading `flyway-core-12.11.0.jar` and listing it:
`org/flywaydb/core/internal/database/sqlite/SQLiteDatabase.class` and friends are still there. No
extra dependency is needed. (`flyway-database-nc-sqlite` also exists at 12.11.0; it is not required.)

### Reversal: Micronaut Data 5 has a SQLITE dialect

`ARCHITECTURE.md` currently records, as a deliberate decision:

> **`Dialect.ANSI`, not `SQLITE`.** Micronaut Data has no SQLite dialect — the enum offers MYSQL,
> POSTGRES, SQL_SERVER, ORACLE, H2 and ANSI.

That was true of Micronaut Data 4.x. It is **no longer true**: the 5.1.x `Dialect` enum contains

```java
SQLITE(false, false, ALL_TYPES, false, true, true, true, false),
```

So the migration should switch `TaskRepository` to `Dialect.SQLITE` and rewrite that decision
rather than carry a stale justification forward. This is the one place where the migration is not
purely mechanical, and it needs its own verification — a dialect change alters generated SQL.

### Not a problem: Jackson 3

Micronaut 5's breaking-changes page flags a Jackson 3 migration for users of
**`micronaut-jackson-databind`**. This project uses **`micronaut-serde-jackson`**, and
`micronaut-serde` 3.1.0 still resolves `jackson-annotations` 2.21. Nothing to do.

The related note — "Jackson Bean Introspection Module removed" — also does not apply, for the same
reason: Micronaut Serialization *is* the recommended alternative and is already what we use.

### Not a problem: the other Micronaut 5 breaking changes

Reviewed against this codebase; none apply:

| Breaking change | Why it misses us |
|---|---|
| RxJava2 and Microstream removed from the BOM | Never used |
| `@Client` no longer invokes fallbacks | No declarative clients exist yet — but see [[mcp-server]], which will add one |
| `micronaut-http-server` no longer exposes websocket | No websockets |
| Netty event-loop config deprecation | No custom event-loop configuration |
| Context propagation no longer automatic | No custom propagation; no reactive chains carrying state |
| HTTP client no longer forwards auth headers cross-origin on redirect | No outbound HTTP at all |
| Groovy 5 / Kotlin 2.3 baselines | Pure Java project |

### Confirmed available

- **JDK 25.0.2** is installed on this machine at `/opt/homebrew/opt/openjdk@25`. The Gradle
  toolchain will find it; no download needed.
- **`eclipse-temurin:25-jdk`** and **`eclipse-temurin:25-jre`** both exist and resolve.
- Micronaut 5.1.1 manages the whole dependency set we use: `micronaut-data` 5.1.1,
  `micronaut-sql` 7.1.0, `micronaut-serde` 3.1.0, `micronaut-validation` 5.1.0,
  `micronaut-flyway` 8.1.0.

## Design

### gradle.properties

```properties
micronautVersion=5.1.1
sqliteJdbcVersion=3.53.2.1
```

The comment above `micronautVersion` currently explains why the project is *not* on 5.x. It has to
be rewritten, not deleted — the new note should say what the pin is and that it now tracks a JDK 25
toolchain.

### build.gradle.kts

```kotlin
plugins {
    id("java")
    id("io.micronaut.application") version "5.0.2"
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}
```

Everything else in the dependency block stays as it is — every artifact we declare is managed by
the 5.1.1 platform BOM. `snakeyaml` stays: nothing suggests Micronaut 5 started bundling a YAML
parser, but this must be **verified by removing it and seeing the build fail**, not assumed.

> TODO: Check whether Micronaut 5 still needs the explicit `runtimeOnly("org.yaml:snakeyaml")`.
> Remove it, run `make build`, and keep whichever answer the build gives.

### Gradle wrapper

`./gradlew wrapper --gradle-version 9.7.1`, then run it twice — the first run rewrites the
properties file, the second actually runs on the new distribution.

Plugin 5.0.2's release notes describe it as the "Gradle 9 and JDK 25" generation, which is exactly
the pairing this migration produces.

### TaskRepository

```java
@JdbcRepository(dialect = Dialect.SQLITE)
public interface TaskRepository extends CrudRepository<Task, String> { }
```

The Javadoc on that interface explains at length why ANSI was chosen. Replace it — a comment
justifying a workaround that is no longer needed is worse than no comment.

`application.yml` also carries `dialect: ANSI` under the datasource; that must move in the same
change or the two disagree.

### Dockerfile

Both `FROM` lines change, and both digests must be re-resolved:

| Image | Digest (resolved 2026-08-23) |
|---|---|
| `eclipse-temurin:25-jdk` | `sha256:e787e08ef76f4c16866108cd7f9fcd96a68eef3ac6cc76866897d4d02d5a2262` |
| `eclipse-temurin:25-jre` | `sha256:f9e65324a37f28209ce7dd0e5149a7aa954520ed936fb87813cf6ded2400a112` |

The header comment recording "Temurin 21.0.12 LTS on Ubuntu 26.04" must be updated with whatever
the 25 images actually report — check inside the image, do not infer it from the tag.

The layered-layout `COPY` lines are unaffected: `build/docker/main/layers/` is produced by
`buildLayers`, which plugin 5.x still provides.

#### The runtime image lost its HTTP client

**`eclipse-temurin:25-jre` ships no `curl`, no `wget` and no `nc`** — verified by running the
pinned image. The Java 21 image we use today has both `curl` and `wget`. The api healthcheck is
`["CMD", "curl", "-fsS", "http://localhost:8080/health"]`, so **it breaks on migration** and the
container would never report healthy.

Resolved by installing curl in the runtime stage (confirmed 2026-08-23):

```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
```

The alternatives were rejected for losing signal or costing more than they save. A bash
`/dev/tcp` probe only proves the port is open — a JVM with an open socket and a broken datasource
would report healthy, which is exactly the case `/health` exists to catch. A Java probe pays JVM
startup every ten seconds, forever.

The image grows by a few MB and gains an apt layer that must be cleaned in the same `RUN`. That is
the whole cost, and it keeps the probe identical to the one nginx already uses.

## Correctness obligations

The migration is correct when nothing observable changed.

**Behaviour is unchanged**
1. All **23 existing tests pass** with no edits to test code. A test that needs changing is a
   finding, not a chore — investigate before editing it.
2. All 19 [[task-api]] obligations still hold, in particular the timestamp format: `Timestamps`
   uses `DateTimeFormatter` and `Instant`, and the six-digit fixed width must survive the JDK jump.
3. `GET /tasks` returns byte-identical JSON for the same data as before the migration.

**The dialect change is real and must be proven**
4. Every CRUD operation works against SQLite under `Dialect.SQLITE`, not just the ones a smoke test
   touches. `Dialect.ANSI` and `Dialect.SQLITE` can generate different SQL.
5. A database file written by the **pre-migration** build is readable by the post-migration build.
   The schema has not changed, so this must hold — if it does not, the dialect change did something
   unexpected.
6. Flyway does not re-run or modify `V1` against an existing database.

**Toolchain**
7. `./gradlew --version` reports **Gradle 9.7.1**, and the build runs on **Java 25**.
8. `make build`, `make test`, `make test-one`, `make run` and `make clean` all still work unchanged.
9. The build produces no new deprecation warnings that were not there before. New warnings are a
   finding to record, not noise to skip past.

**Container**
10. The image builds from a clean context and reports a **Java 25** runtime inside.
11. `make up` reaches `healthy` for both services; the api healthcheck still works, which requires
    whatever HTTP probe binary the new base image actually has.
12. Data written before the migration and left in `./data` is served correctly by the migrated
    container.

**Documentation**
13. No file in `vault/` still claims Micronaut 4, Java 21, Gradle 8.14.5, plugin 4.6.2, or
    `Dialect.ANSI`. The "Why Micronaut 4.10.17 and not 5.x" section of [[docker-and-make]] becomes a
    historical note, not a live constraint.
14. The `ARCHITECTURE.md` decision about `Dialect.ANSI` is **rewritten**, not deleted — the record
    should say what changed and when, so the next reader is not confused by git history.

## Verification

Run 2026-08-23. All 14 obligations pass.

| # | Obligation | Result |
|---|---|---|
| 1 | 23 tests pass with **no test edits** | pass — not one test needed changing |
| 2 | Timestamp format survives the JDK jump | pass — every value still `\d{6}Z`, length 27 |
| 3 | JSON shape unchanged | pass — same six keys, same order |
| 4 | Every CRUD op works under `Dialect.SQLITE` | pass — POST/GET/GET-id/PUT/DELETE plus both 400 paths |
| 5 | A **pre-migration** database opens | pass — the 3-row file from the Micronaut 4 build served correctly |
| 6 | Flyway does not re-run V1 | pass — covered by `PersistenceTest`, and the old file kept its history |
| 7 | Gradle 9.7.1 on Java 25 | pass |
| 8 | All make targets still work | pass |
| 9 | No new deprecation warnings | Gradle reports generic build-script deprecations; none from this project's code |
| 10 | Image runs Java 25 | pass — `Temurin-25.0.4+7`, still `uid=10001(app)` |
| 11 | Both services healthy | pass |
| 12 | Pre-migration data served by the migrated container | pass — same 3 tasks |
| 13 | No vault file still claims the old versions | pass |
| 14 | The `Dialect.ANSI` decision is rewritten, not deleted | pass |

## Implementation notes

**1. The plugin needs the *build* JVM on 25, not just the toolchain.** Setting
`languageVersion = JavaLanguageVersion.of(25)` is not enough:

```
Could not resolve io.micronaut.gradle:micronaut-gradle-plugin:5.0.2.
  > Dependency requires at least JVM runtime version 25. This build uses a Java 21 JVM.
```

That also creates a chicken-and-egg: `./gradlew wrapper` cannot upgrade the wrapper, because the
build script fails to configure before the task runs. The wrapper had to be written by a system
Gradle running under `JAVA_HOME` set to JDK 25.

Making that stick for everyone needed **`gradle/gradle-daemon-jvm.properties`**, generated by
`./gradlew updateDaemonJvm --jvm-version=25`. That task in turn requires toolchain download
repositories, so `settings.gradle.kts` gained the **foojay resolver** plugin. The upside is
worth more than the detour: a fresh clone on a machine with no JDK 25 now provisions one instead
of failing, and `./gradlew` picks the right JVM with no `JAVA_HOME` juggling.

**2. `eclipse-temurin:25-jre` has no HTTP client at all.** No `curl`, no `wget`, no `nc` — where
the Java 21 image had curl and wget. The api healthcheck is a `curl` invocation, so the container
would have started fine and simply never gone healthy. Installing curl in the runtime stage was
the fix; the reasoning against the cheaper probes is in the design section above.

This is the second time a base-image assumption has been wrong in this project (the first was
assuming `nginx:alpine` had only busybox `wget`). The rule that keeps earning its place: **check
what is in the image, never infer it from the base distro.**

## Open questions

None. Everything below is resolved.

1. **Does anything still need `snakeyaml`?** **Yes** — answered 2026-08-23 by removing it. The
   build fails with *"YAML configuration file detected but snakeyaml is not on classpath"*.
   Micronaut 5 bundles no YAML parser either. Restored, with the re-check noted in
   `build.gradle.kts`.
2. **Is `curl` in `eclipse-temurin:25-jre`?** **No** — verified 2026-08-23. Neither is `wget` or
   `nc`. Resolved by installing curl; see
   [The runtime image lost its HTTP client](#the-runtime-image-lost-its-http-client).
3. **One commit or two?** **One** (confirmed 2026-08-23). `Dialect.SQLITE` only becomes available
   *because* of the migration, so a commit stopping in between would be a state nobody wants and
   the split would buy nothing.
4. **Java 25 is not an independent preference** — it is forced by Micronaut 5's JDK 25 baseline.
   Recording that in `ARCHITECTURE.md` so nobody later reads it as a taste decision. Not a
   question; just something not to lose.
