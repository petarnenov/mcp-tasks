# Specs

One file per feature. Newest first.

Copy [`_template.md`](_template.md) to `<slug>.md` to start a new spec. Read the relevant spec
before implementing it; update it when scope changes.

## Index

| Spec | Status | Summary |
|---|---|---|
| [mcp-apps](mcp-apps.md) | draft | The fourth primitive: a server-rendered task board as an MCP App (`io.modelcontextprotocol/ui`) — a `ui://` resource, a tool linked to it, and one write path back through the host. Needs a new dependency; not renderable in our own client. |
| [github-publish](github-publish.md) | shipped | Published as **[petarnenov/mcp-tasks](https://github.com/petarnenov/mcp-tasks)**: name choice, an audit of what becomes public, `gh repo create`, and the push. Verified 2026-08-24, 10 obligations, including a fresh clone that builds. |
| [mcp-prompts](mcp-prompts.md) | shipped | The third primitive: `triage_tasks` and `plan_task`, each embedding the resource it talks about, plus a prompts panel in the browser client. Verified 2026-08-24, 21 obligations. |
| [mcp-resources](mcp-resources.md) | shipped | Two MCP resources — `tasks://tasks` and the `tasks://tasks/{id}` template with id completion — plus a resources panel in the browser client. Verified 2026-08-24, 20 obligations. |
| [mcp-client](mcp-client.md) | shipped | A browser MCP client served at `:8080/mcp/client`, negotiating 2026-07-28 with a loud downgrade. Tool list, generated forms, message log. No LLM. Verified 2026-08-23, 16 obligations. |
| [mcp-server-typescript](mcp-server-typescript.md) | shipped | The MCP server rewritten in TypeScript on SDK 2.0.0, serving the **2026-07-28** protocol revision. Same five tools, same ports, same 3 replicas. Verified 2026-08-23, 20 obligations. |
| [mcp-server](mcp-server.md) | superseded by [[mcp-server-typescript]] | The Java implementation. Its design still governs; only the language and SDK changed. Verified 2026-08-23, 22 of 23 obligations. |
| [micronaut-5-migration](micronaut-5-migration.md) | shipped | Micronaut 4.10.17 → 5.1.1, Java 21 → 25, Gradle 8.14.5 → 9.7.1, `Dialect.ANSI` → `SQLITE`. Verified 2026-08-23, 14 obligations. |
| [nginx-load-balancer](nginx-load-balancer.md) | shipped | Nginx front door on port 8080; the api container is unpublished behind it. One backend — SQLite cannot take two writers. Verified 2026-08-23, 20 obligations. |
| [docker-and-make](docker-and-make.md) | shipped | Multi-stage Dockerfile, Compose with a persistent SQLite bind mount, and a Makefile as the single entry point. Verified 2026-08-23; 18 of 19 obligations pass, obligation 7 needs a Linux host. |
| [task-api](task-api.md) | shipped | Local Micronaut 5.1.1 / Java 25 service over SQLite: 5 CRUD endpoints for tasks. Implemented and verified 2026-08-23; 19 obligations, 22 passing tests. |
