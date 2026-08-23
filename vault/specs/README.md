# Specs

One file per feature. Newest first.

Copy [`_template.md`](_template.md) to `<slug>.md` to start a new spec. Read the relevant spec
before implementing it; update it when scope changes.

## Index

| Spec | Status | Summary |
|---|---|---|
| [mcp-server](mcp-server.md) | shipped | MCP wrapper over the task API on 8877 (and `8080/mcp`), behind nginx, 3 replicas. Verified 2026-08-23; 22 of 23 obligations, no real MCP client tried yet. |
| [micronaut-5-migration](micronaut-5-migration.md) | shipped | Micronaut 4.10.17 → 5.1.1, Java 21 → 25, Gradle 8.14.5 → 9.7.1, `Dialect.ANSI` → `SQLITE`. Verified 2026-08-23, 14 obligations. |
| [nginx-load-balancer](nginx-load-balancer.md) | shipped | Nginx front door on port 8080; the api container is unpublished behind it. One backend — SQLite cannot take two writers. Verified 2026-08-23, 20 obligations. |
| [docker-and-make](docker-and-make.md) | shipped | Multi-stage Dockerfile, Compose with a persistent SQLite bind mount, and a Makefile as the single entry point. Verified 2026-08-23; 18 of 19 obligations pass, obligation 7 needs a Linux host. |
| [task-api](task-api.md) | shipped | Local Micronaut 5.1.1 / Java 25 service over SQLite: 5 CRUD endpoints for tasks. Implemented and verified 2026-08-23; 19 obligations, 22 passing tests. |
