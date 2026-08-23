# Docker & Make

**Status:** shipped
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-23

> **Shipped 2026-08-23.** All seven decisions implemented; 18 of 19 obligations verified, with
> obligation 7 explicitly **unverified** — it needs a Linux host. Two things the implementation
> forced are in [Implementation notes](#implementation-notes), and the design text above them has
> been corrected to match the code rather than left describing the plan.

## Problem

Running the service today means knowing that it is a Gradle project, that the wrapper is the right
entry point, that it must be started from the repository root or the database lands in the wrong
place, and that `-runner.jar` is the runnable one. None of that is discoverable — it lives in
[`../QUALITY.md`](../QUALITY.md) and in this session's history.

Two gaps follow:

1. **No container.** The service cannot be handed to someone who does not have a Java 21 toolchain,
   and there is no reproducible runtime — it runs against whatever JDK happens to be on the machine.
2. **No single entry point.** Every operation is a different tool with different flags. There is no
   one place that answers "what can I do in this repo?"

## Scope

**Containerization**
- A hand-written multi-stage `Dockerfile` at the repository root, with base images pinned by
  digest.
- `.dockerignore` so the build context excludes build output, caches, the database, and `.git`.
- `compose.yaml` running the service with persistent storage and a healthcheck.

**Make**
- A `Makefile` that is the documented entry point for **every** operation in this repo — local
  build and test, Docker, and database inspection.
- `make` with no arguments prints self-documenting help.
- [`../QUALITY.md`](../QUALITY.md) gate table is rewritten in terms of `make` targets in the same
  change, with the underlying `./gradlew` commands kept as the second column.

**Two application changes** (confirmed 2026-08-23)
- Add `micronaut-management` so `/health` exists. A Compose service without a healthcheck cannot
  report readiness — `make ps` would say `Up` for a service that is crash-looping.
- **Change the default database path** in `application.yml` from `tasks.db` to `data/tasks.db`, so
  the local and containerized service use the same file. Today they would diverge; see
  [Where the database lives](#where-the-database-lives). This edits [[task-api]]'s Configuration
  section, `ARCHITECTURE.md`, and `.gitignore` in the same change.

**Non-goals:**
- Publishing to any registry. `docker push`, tags beyond `latest`, and registry credentials are all
  out. The image is built and run locally.
- GraalVM native image. The Micronaut plugin offers `dockerBuildNative`; it is a different set of
  constraints (reflection config, longer builds) and is not worth it for a local CRUD service.
- Multi-service composition. There is no database container — SQLite is a file, not a server.
  Compose here runs exactly one service.
- **Horizontal scaling.** `docker compose up --scale` is unsupported and unsafe: SQLite takes one
  writer and the pool is deliberately sized at 1.
- CI, deployment, orchestration, Kubernetes manifests.
- Cross-compilation or multi-arch (`buildx`) images.
- Adding lint/format/coverage targets to the Makefile. Those tools are not configured in this repo
  (see [`../QUALITY.md`](../QUALITY.md) *Known gaps*), and a `make lint` that does nothing is worse
  than no target at all.

## Design

### Why a hand-written Dockerfile

The Micronaut Gradle plugin already provides `dockerfile`, `dockerBuild`, `dockerBuildNative` and
`dockerPush` — verified with `./gradlew tasks --all`. This spec does **not** use them.

The plugin generates into `build/docker/main/Dockerfile`, which is a build artifact: it is not in
version control, not reviewable in a diff, and changes when the plugin version changes. A
`Dockerfile` at the repository root is the artifact every reader expects, Compose can point at it
directly, and its content is auditable. The cost is that the image definition no longer follows
plugin upgrades automatically — an acceptable trade for something this small.

### Dockerfile

Two stages. The builder holds the JDK, the Gradle distribution and the whole source tree; the
runtime holds a JRE and one jar.

```dockerfile
# ---- build ----
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src

# Wrapper and build files first, so a source-only edit does not re-download dependencies.
COPY gradlew settings.gradle.kts build.gradle.kts gradle.properties ./
COPY gradle ./gradle
RUN ./gradlew --no-daemon dependencies > /dev/null

COPY src ./src
RUN ./gradlew --no-daemon build -x test

# ---- runtime ----
FROM eclipse-temurin:21-jre AS runtime
RUN useradd --system --uid 10001 --create-home app
WORKDIR /app
COPY --from=build /src/build/docker/main/layers/libs      /app/libs
COPY --from=build /src/build/docker/main/layers/resources /app/resources
COPY --from=build /src/build/docker/main/layers/app/application.jar /app/application.jar
ENV DATASOURCES_DEFAULT_URL=jdbc:sqlite:/data/tasks.db
USER 10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/application.jar"]
```

Notes on choices that are not arbitrary:

- **`-x test` in the image build.** Tests are a gate, not a packaging step; `make test` runs them.
  Running them here would double the image build time and fail the build for reasons unrelated to
  packaging.
- **A JRE, not a JDK, at runtime.** Nothing compiles in the running container.
- **A fixed non-root UID (10001).** Needed both for least privilege and so the bind-mount
  permission behaviour below is predictable rather than dependent on the base image's user table.
- **Micronaut's layered layout, not a fat jar.** This project produces no self-contained jar —
  see [Implementation notes](#implementation-notes). `build/docker/main/layers/` holds
  `application.jar` plus the `libs/` and `resources/` directories its manifest Class-Path points
  at. Copying dependencies before the application jar also means a source-only change rebuilds one
  small layer rather than the 62-jar dependency layer (verified: obligation 11).

**Base images are pinned by digest** (confirmed 2026-08-23): `eclipse-temurin:21-jdk@sha256:…` and
`eclipse-temurin:21-jre@sha256:…`. A floating tag means the same Dockerfile produces a different
image next month, which defeats half the point of containerizing. The cost is that security patches
require a deliberate edit — that edit is visible in a diff, which is the trade being made.

Resolved 2026-08-23, both to Temurin **21.0.12 LTS on Ubuntu 26.04**:

| Image | Digest |
|---|---|
| `eclipse-temurin:21-jdk` | `sha256:85f00967bcc624fc19fa9c2cf124ea426a5363898e267141726f31f358c2e14b` |
| `eclipse-temurin:21-jre` | `sha256:7a65df4b22d2de92d4e04056e884f3b9122d70b21e2847fd66084278bd0ce037` |

Re-resolve with `docker buildx imagetools inspect eclipse-temurin:21-jre`.

### Where the database lives

This is the part that actually needs deciding, not the Dockerfile.

The application writes `tasks.db` relative to the process working directory. In a container that
would be `/app/tasks.db` — inside the image's writable layer, destroyed with the container. So the
container gets an explicit absolute path and a mount:

| | `make run` (host) | `make up` (container) |
|---|---|---|
| Database file | `./data/tasks.db` | `./data/tasks.db` via `/data/tasks.db` |
| Set by | `application.yml` default | Compose bind mount + `DATASOURCES_DEFAULT_URL` |

**Both modes use the same file** (confirmed 2026-08-23). The `application.yml` default changes from
`jdbc:sqlite:tasks.db` to `jdbc:sqlite:data/tasks.db` so that starting the service two different
ways does not silently give you two different databases — the trap being closed here is "I created
a task, restarted, and it vanished" when the only thing that changed was `make run` versus
`make up`.

The existing `./tasks.db` at the repo root becomes orphaned. It holds nothing but smoke-test rows,
so the implementation deletes it; `.gitignore` swaps its three `tasks.db*` lines for `data/`.

A **bind mount** rather than a named volume (confirmed 2026-08-23): the file stays visible on the
host, so `sqlite3 data/tasks.db` still works, backing up is `cp`, and resetting is `rm`. A named
volume is tidier for lifecycle but opaque, and this is a local development tool where being able to
open the file matters more.

Micronaut maps `DATASOURCES_DEFAULT_URL` onto `datasources.default.url` by its standard environment
variable convention, so this needs no application code change.

**The permissions trap.** The container runs as UID 10001. A bind-mounted host directory keeps its
host ownership, so on Linux the container gets `permission denied` writing `tasks.db` unless the
host directory is owned by, or writable to, that UID. On macOS with Docker Desktop the file sharing
layer papers over this and it appears to work. That difference is exactly why it is
[obligation 7](#correctness-obligations) rather than a footnote: it is a bug that will not
reproduce on the author's machine.

`data/` must be added to both `.gitignore` and `.dockerignore`.

### compose.yaml

```yaml
services:
  api:
    build:
      context: .
    image: tasks:latest
    ports:
      - "${PORT:-8080}:8080"
    environment:
      DATASOURCES_DEFAULT_URL: jdbc:sqlite:/data/tasks.db
    volumes:
      - ./data:/data
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8080/health"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 20s
```

- **No `version:` key.** It is obsolete under the Compose Spec and current Compose warns about it.
- **No `restart: unless-stopped`.** That would resurrect the service on every Docker daemon start,
  which is wrong for a development tool the user starts deliberately.
- **`curl` in the healthcheck** requires curl in the runtime image; `eclipse-temurin:21-jre` is
  Ubuntu-based and has it. If the base image is later switched to a distroless or Alpine variant
  this healthcheck breaks — see the TODO below.

**The probe uses `curl`** (confirmed 2026-08-23) — standard, readable, and free of the JVM startup
cost that a Java-based probe would pay every 10 seconds.

Verified 2026-08-23 by running the pinned image: **curl 8.18.0** is present at `/usr/bin/curl`
(`wget` is there too, unused). The fallback was not needed.

### The /health endpoint

`micronaut-management` is **not** currently on the classpath — confirmed against
`build.gradle.kts`. There is no `/health` today and the healthcheck above would fail against the
service as it stands.

Adding it:

```kotlin
implementation("io.micronaut:micronaut-management")
```

This exposes `/health`, which returns `{"status":"UP"}` and reports the datasource. Default
Micronaut behaviour is that `/health` is not sensitive, so no configuration is required. It also
exposes nothing else by default — other management endpoints stay disabled.

### Makefile

Targeting **GNU Make 3.81**, which is what macOS ships (verified: `make --version`). That is the
floor, and it rules out `.ONESHELL` (3.82+), so **every recipe line runs in its own shell** — a
recipe that needs state across lines chains with `&&` instead of relying on line continuation.

```makefile
# .SHELLFLAGS is SILENTLY IGNORED by Make 3.81 (verified) — the flags go on SHELL itself.
SHELL := /bin/bash -o pipefail -e
.DEFAULT_GOAL := help

IMAGE   ?= tasks
TAG     ?= latest
PORT    ?= 8080
COMPOSE ?= docker compose
GRADLE  := ./gradlew
DB      := data/tasks.db

.PHONY: help build test test-one run clean \
        docker-build up down restart logs shell ps \
        db-shell db-reset

## ---- Local ----------------------------------------------------------------

help:  ## Print this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

build:  ## Compile and assemble the jar (runs tests)
	$(GRADLE) build

test:  ## Run the full test suite
	$(GRADLE) test

test-one:  ## Run one test class or method: make test-one TEST='*TimestampsTest*'
	$(GRADLE) test --tests '$(TEST)'

run:  ## Run the service locally on the host (no Docker)
	$(GRADLE) run

clean:  ## Remove build output. Does NOT touch the database
	$(GRADLE) clean

## ---- Docker ---------------------------------------------------------------

docker-build:  ## Build the container image
	docker build -t $(IMAGE):$(TAG) .

up:  ## Start the service in Docker (builds if needed)
	$(COMPOSE) up --build -d
	@echo "http://localhost:$(PORT)/tasks"

down:  ## Stop the service. Data in ./data survives
	$(COMPOSE) down

restart: down up  ## Stop then start

logs:  ## Follow the service logs
	$(COMPOSE) logs -f api

shell:  ## Open a shell inside the running container
	$(COMPOSE) exec api /bin/bash

ps:  ## Show container status and health
	$(COMPOSE) ps

## ---- Database -------------------------------------------------------------

db-shell:  ## Open sqlite3 against the Docker database
	sqlite3 $(DB)

db-reset:  ## DELETE the database. Destructive, asks first
	@printf 'Delete %s? [y/N] ' '$(DB)' && read ans && [ "$$ans" = "y" ]
	rm -f $(DB) $(DB)-shm $(DB)-wal
```

Standards this follows, each for a reason rather than for style:

| Convention | Why |
|---|---|
| `.DEFAULT_GOAL := help` | A bare `make` should explain the repo, never start a build as a side effect |
| `## ` comments + `help` target | Help is generated from the targets, so it cannot drift out of date |
| `.PHONY` on every target | None of these produce a file of that name; without it a file called `test` silently breaks `make test` |
| Flags on `SHELL`, not `.SHELLFLAGS` | Make 3.81 ignores `.SHELLFLAGS` without warning — see [Implementation notes](#implementation-notes). Putting `-e -o pipefail` on `SHELL` works on both 3.81 and 4.x |
| `?=` for `IMAGE`/`TAG`/`PORT` | Overridable from the environment: `PORT=9000 make up` |
| `build` runs tests | Mirrors `./gradlew build` exactly (confirmed 2026-08-23). "make build passed" means ready to commit, and there is no hidden difference between the make target and the Gradle command it wraps |
| `clean` never deletes data | A destructive action must be its own explicitly named target |
| `db-reset` confirms | The one irreversible target in the file |

## Correctness obligations

Each is a test target — here mostly a manual or scripted check, since there is no test harness for
Make and Docker in this repo.

**Make**
1. `make` with no arguments prints help, exits 0, and builds nothing.
2. Every target listed in `make help` exists and runs; every non-file target is in `.PHONY`.
3. The Makefile works under **GNU Make 3.81** — no `.ONESHELL`, no `.RECIPEPREFIX`, no `$(file …)`.
4. A failing underlying command fails the make target with a non-zero exit code, including mid-pipe.
5. `make clean` leaves `data/tasks.db` untouched.
6. `make db-reset` deletes nothing when the prompt is answered with anything other than `y`.

**Container**
7. The container writes successfully to the bind-mounted `./data` **as a non-root user**. Verified
   on Linux, not only on macOS, where Docker Desktop's file sharing hides UID mismatches.
8. `docker inspect` confirms the image's user is 10001, not root.
9. The runtime image contains no source, no Gradle cache and no JDK — only a JRE and the jar.
10. The image builds from a clean checkout with no host Java installed.
11. Editing only a file under `src/` does not re-resolve dependencies on rebuild (the layer split
    works).

**Compose**
12. `make up` then `make down` then `make up` returns the same tasks — data survives the container.
13. `make down` does not delete `./data`.
14. `make ps` reports the service as `healthy` once `/health` responds; a service that never becomes
    healthy is visible as such rather than reported as running.
15. `compose.yaml` has no `version:` key and produces no warning on a current Compose.
16. `PORT=9000 make up` serves on 9000.

**Application**
17. `GET /health` returns 200 with status `UP`.
18. Adding `micronaut-management` does not break any of the 19 obligations in [[task-api]] — the
    existing 22 tests still pass.
19. `data/` is in both `.gitignore` and `.dockerignore`, and `git status` stays clean after a
    `make up`.

## Verification

Run 2026-08-23 against the built image and a running Compose service.

| Gate | Result |
|---|---|
| `make` (bare) | Prints help, exits 0, builds nothing |
| `make test` | **23 tests, 0 failures** (22 existing + the new health test) |
| `make docker-build` | Image `tasks:latest`, **354 MB** (base JRE alone is 324 MB, so the app adds ~30 MB) |
| `make up` | Reaches `healthy`; Flyway applies V1 into the bind-mounted file on first start |
| `make down && make up` | Task count unchanged — data survived |

Obligation results:

| # | Obligation | Result |
|---|---|---|
| 1 | Bare `make` prints help, builds nothing | pass |
| 2 | Every target exists and is `.PHONY` | pass — all 15 |
| 3 | Works under GNU Make 3.81 | pass — but only after the `.SHELLFLAGS` fix below |
| 4 | A failing command fails the target | pass — `make test-one` with no `TEST` exits `Error 1` |
| 5 | `make clean` leaves the database | pass |
| 6 | `make db-reset` aborts on anything but `y` | pass — answered `n`, file survived |
| 7 | Non-root writes to the bind mount | **UNVERIFIED — see below** |
| 8 | Image user is 10001, not root | pass — `uid=10001(app)` |
| 9 | No source, JDK or Gradle cache in the runtime image | pass — `/src` absent, no `javac`, `/app` holds only the three copied paths |
| 10 | Builds from a clean context with no host Java | pass — `.dockerignore` excludes `build/` and `.gradle/`; the JDK comes from the builder image |
| 11 | A source-only edit does not re-resolve dependencies | pass — dependency layer `CACHED`, only `COPY src` and the build re-ran |
| 12 | Data survives `down`/`up` | pass |
| 13 | `make down` does not delete `./data` | pass |
| 14 | An unhealthy service is visible as unhealthy | pass — observed for real during the packaging failure below, which reported `unhealthy` rather than `Up` |
| 15 | No `version:` key, no Compose warnings | pass — `docker compose config -q` silent |
| 16 | `PORT=9000 make up` serves on 9000 | pass — 9000 returns 200, 8080 nothing |
| 17 | `GET /health` returns 200 UP | pass — `{"status":"UP"}`, covered by `HealthTest` |
| 18 | `micronaut-management` breaks nothing | pass — all 22 prior tests still green |
| 19 | `data/` ignored by git and Docker | pass — `git status` clean after `make up` |

### Obligation 7 is not cleared

The container (UID 10001) does write `data/tasks.db` successfully **on this macOS host**, and the
file shows up owned by the host user. That proves nothing about Linux: Docker Desktop's file
sharing layer remaps ownership, which is exactly the behaviour that hides this class of bug. On a
Linux host, `./data` owned by the invoking user and a container running as UID 10001 can produce
`permission denied` on first write.

**This obligation stays open until someone runs `make up` on Linux.** If it fails there, the fix is
either `user: "${UID}:${GID}"` in `compose.yaml` or an entrypoint that chowns `/data` — do not
"fix" it by reverting to root.

## Implementation notes

Two things the implementation forced. Both were real failures, not preferences.

**1. Neither jar this project builds is self-contained.** The spec said to copy
`tasks-<version>-runner.jar`. The container started and immediately died with
`NoClassDefFoundError: io/micronaut/runtime/Micronaut`.

The runner jar's manifest carries `Class-Path: resources/ classes/ libs/...` — it expects sibling
directories that exist only under `build/docker/main/layers/`, never next to the jar in
`build/libs/`. `java -jar build/libs/tasks-0.1.0-runner.jar` fails on the host for the same reason.
The Micronaut Gradle plugin does not produce a fat jar unless the Shadow plugin is added.

The fix was to copy the layered layout, which needs no new plugin and improves layer caching. The
consequence beyond Docker: **there is no "just run the jar" story for this project.** Use
`make run` locally, or `./gradlew installDist` for a standalone launcher.

**2. GNU Make 3.81 silently ignores `.SHELLFLAGS`.** Verified directly: with
`.SHELLFLAGS := -eu -o pipefail -c` set, `false | true` still reported exit 0, and Make printed no
warning. The Makefile would have *looked* strict on macOS while letting failed pipes pass.

Putting the flags on `SHELL` itself — `SHELL := /bin/bash -o pipefail -e` — works on 3.81 and on
4.x, verified both by a failing pipe correctly aborting a target. There is a comment in the
Makefile telling future readers not to "modernize" this back into `.SHELLFLAGS`.

Also worth knowing: the Micronaut Gradle plugin's `dockerfile` task **uses the root `Dockerfile`
when one exists** instead of generating its own. So the hand-written file is authoritative even if
someone runs a plugin Docker task by accident.

## Open questions

None. All seven were answered by the owner on 2026-08-23:

| Was open | Decided |
|---|---|
| Dockerfile: hand-written or plugin `dockerBuild`? | **Hand-written**, at the repo root, in version control |
| SQLite storage: bind mount or named volume? | **Bind mount** `./data`, so the file stays openable with `sqlite3` |
| Add `micronaut-management` for `/health`? | **Yes** — a healthcheck that reports readiness is worth one dependency |
| Unify the local and container database path? | **Yes** — both use `./data/tasks.db`; `application.yml` default changes |
| Pin base images by digest? | **Yes**, digest-pinned; patches become a deliberate, reviewable edit |
| Healthcheck probe? | **`curl`**; fall back to `wget` if the pinned image lacks it, without re-asking |
| Should `make build` run tests? | **Yes** — identical to `./gradlew build`, no hidden difference |

Both implementation-time TODOs are closed: the digests are recorded in
[Dockerfile](#dockerfile), and `curl` was confirmed present in the pinned runtime image.

Record new questions here as they come up rather than deciding them silently in code.
