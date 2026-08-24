# MCP Apps: a server-rendered task board

**Status:** draft
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-24

> The fourth thing this server would offer. Tools are actions, resources are material, prompts are
> named ways to start — an **app** is a view: the server ships HTML, the host renders it in a
> sandboxed iframe, and the person clicks instead of typing.
>
> Explicitly a **learning exercise** (the owner's framing). That decides the scope below: one tool,
> one view, one write path, and every mechanism exercised once rather than a board anyone would use
> daily.

## Problem

Everything this server returns is text a model reads. `tasks_list` hands back eleven JSON objects
and the person reads them through the model's summary of them — fine for "what is on my list",
useless for "drag these three into DONE". A task list is the canonical case for a view: it is
tabular, it is stateful, and the actions on it are single clicks.

MCP Apps is the standardised way to do that, and it is not a side project: the extension shipped in
the **2026-07-28** release — the exact revision this server already serves — under the identifier
`io.modelcontextprotocol/ui`, with its own specification dated 2026-01-26.

## Scope

- One UI resource, `ui://tasks/board`, serving a self-contained HTML page.
- One tool, `tasks_board`, linked to it through `_meta.ui.resourceUri`.
- The view renders the task list it receives from `ui/notifications/tool-result`.
- **One write path:** clicking a card's status calls `tasks_update` back through the host, and then
  tells the conversation what happened with `ui/update-model-context`.
- Graceful degradation: a host that does not implement the extension still gets a useful
  `tasks_board` result, because the view is an addition to the content, not a replacement for it.

**Non-goals:** teaching our own browser client to *host* apps (that is App Bridge, a much larger
job — see Open questions); React, Vue or any framework; external CDNs; `permissions` (camera,
microphone, geolocation); `fullscreen` / `pip` display modes; `ui/open-link`; streaming partial
inputs (`ui/notifications/tool-input-partial`); persisting any view state server-side.

## Design

### What the extension actually is

Verified against the specification rather than recalled. The moving parts:

| Piece | Value |
|---|---|
| Extension id | `io.modelcontextprotocol/ui` |
| Resource URI scheme | `ui://` |
| Resource MIME type | `text/html;profile=mcp-app` |
| Tool → view link | `_meta.ui.resourceUri`, plus optional `_meta.ui.visibility` |
| Client capability | `capabilities.extensions["io.modelcontextprotocol/ui"] = { mimeTypes: [...] }` |
| Transport to the view | JSON-RPC 2.0 over `postMessage`, methods prefixed `ui/` |
| Sandbox | `<iframe sandbox="allow-scripts allow-same-origin">`, minimum |

The view talks back with `ui/open-link`, `ui/message`, `ui/request-display-mode` and
`ui/update-model-context`, and it may forward plain `tools/call` and `resources/read`. The host
pushes `ui/notifications/tool-input`, `ui/notifications/tool-result`,
`ui/notifications/tool-cancelled`, `ui/notifications/size-changed` and
`ui/notifications/host-context-changed`. Lifecycle is `ui/initialize` then
`ui/notifications/initialized` — MCP's own shape, one layer down.

**`_meta.ui.resourceUri` is nested.** The flat `_meta["ui/resourceUri"]` form is deprecated and was
removed before GA. Do not copy it out of an older blog post.

### A new dependency, because the installed SDK has none

`@modelcontextprotocol/server` **2.0.0** — what `mcp-server/` runs on — contains **no** MCP Apps
support. Verified by grep across `node_modules/@modelcontextprotocol/`: zero matches for `ui://`,
`outputTemplate`, `uiResource` or the extension id.

The extension lives in a separate package, **`@modelcontextprotocol/ext-apps`** (1.7.5 at the time
of writing), whose `./server` export is exactly what this spec needs:

```ts
export const EXTENSION_ID = "io.modelcontextprotocol/ui";
export declare function registerAppTool(server: Pick<McpServer, "registerTool">, name, config, cb): RegisteredTool;
export declare function registerAppResource(server: Pick<McpServer, "registerResource">, name, uri, config, readCallback): RegisteredResource;
export declare function getUiCapability(clientCapabilities): McpUiClientCapabilities | undefined;
```

Both registrars take `Pick<McpServer, …>`, so they compose with the instance `server.ts` already
builds — no second server, no fork of the assembly. This is the **third** npm dependency for
`mcp-server` and the first one added since the rewrite; it is a deliberate cost, not a detail.

### The app: a board, not a list

`tasks_board` returns every task, and the view renders three columns — `TODO`, `IN_PROGRESS`,
`DONE` — with one card per task showing title, priority and description. Each card carries two
buttons that move it to the other two statuses.

Three columns rather than a table because the single interesting action on a task here *is* the
status change, and a board makes that one click. Priority is shown, not editable: one write path is
enough to prove the mechanism, and a second one would only repeat it.

### The write path, and the trap it walks into

A click calls `tasks_update` back through the host. **`tasks_update` is a full replace** — this is
the same trap `tools.ts` spends a paragraph of tool description on, and the view is the most likely
thing in this repository to fall into it, because a UI naturally thinks in fields:

> Sending `{id, status}` and nothing else silently clears the task's description and resets its
> priority to `MEDIUM`.

So the view must send **every** field back, taken from the card it already holds. That is why the
board renders description and priority even though it does not let you edit them: it needs them in
memory to write them back unchanged. Obligation 9 exists to catch exactly this, and it is the one
worth writing first.

After a successful write the view calls `ui/update-model-context` with a one-line summary, so the
conversation does not silently diverge from what the person just did by hand.

### Capability gating is not available here, and that is structural

The specification's suggested shape is: read the client's capability with
`getUiCapability(clientCapabilities)` and register UI tools only when the host advertises support.
**That cannot be done in this server**, and the reason is the design it already committed to.

`createServerFactory` (`mcp-server/src/server.ts:23`) returns an `McpServerFactory`, which the SDK
calls once per request with an `McpRequestContext`. That context carries exactly three fields —
`era`, `authInfo`, `requestInfo`. **Client capabilities are not among them**, because registration
happens while the instance is being constructed, before the `initialize` that would declare them.
Restructuring to get at them would mean an instance that outlives its request, which is the one
property the replica model depends on.

The resolution is to **register unconditionally and degrade gracefully**: a host that does not
implement the extension sees an ordinary tool with an `_meta` key it ignores, and gets the task list
as text. This is why "the view is an addition to the content, not a replacement for it" is in Scope
rather than being a nicety — it is what makes the missing gate harmless.

Gating on `ctx.era === 'modern'` **is** available and should be used: MCP Apps extends 2026-07-28,
and a 2025-era client has no way to render one. Registering it on the legacy leg advertises
something that era cannot use.

### CSP and self-containment

`_meta.ui.csp` may declare `connectDomains`, `resourceDomains`, `frameDomains` and
`baseUriDomains`. This app declares **none of them** — the HTML inlines its own CSS and JavaScript,
exactly as `mcp-client` does for a different reason. With `csp` omitted the host applies its
restrictive baseline (`script-src 'self' 'unsafe-inline'`, no external connections), which is
precisely what a self-contained page needs and nothing more. Any future chart library is a
deliberate `resourceDomains` entry and a re-review, never an incidental import.

### Where this can actually be seen

The extension is supported by Claude and Claude Desktop, VS Code Copilot, Goose, Postman and MCPJam
among others. **Our own browser client is not in that list and will not be** — it renders tool
results as text and has no iframe, no App Bridge, no postMessage router. `make run-client` is
therefore *not* a verification path for this feature, which is a first for this repository: every
previous MCP feature could be checked there. Verification runs through a real host.

## Correctness obligations

1. `resources/list` includes `ui://tasks/board` with mimeType exactly `text/html;profile=mcp-app`.
2. `resources/read` on that URI returns valid HTML5 with no external `src` or `href` — everything
   inline.
3. `tools/list` includes `tasks_board`, and its `_meta.ui.resourceUri` equals `ui://tasks/board`
   using the **nested** form, not the deprecated `_meta["ui/resourceUri"]`.
4. Calling `tasks_board` returns the same task data as `tasks_list`, so a host that ignores the
   view still gets a usable answer.
5. The board is registered on the **modern** leg only; a `legacy` era instance offers neither the
   tool nor the resource.
6. The view renders every task it receives in the column matching its status, and an empty list
   renders an empty board rather than an error.
7. The view survives a task with a `null` description and one with a 200-character title without
   overflowing its container.
8. Clicking a status button calls `tasks_update` through the host — not the api directly, and not
   through any network call of its own.
9. **The write preserves every field it did not change.** After moving a task with a description
   and `HIGH` priority to `DONE`, a `tasks_get` shows the same description and still `HIGH`. This
   is the full-replace trap and the single most likely defect in the feature.
10. A failed write (task deleted underneath, api down) leaves the card where it was and shows the
    message the tool returned, rather than optimistically moving it.
11. After a successful write the view sends `ui/update-model-context` naming the task and its new
    status.
12. The view never calls `tasks_delete`. Nothing in it can destroy a task.
13. The page runs under the host's default CSP with no console errors, and declares no
    `connectDomains` or `resourceDomains`.
14. The resource declares no `permissions` — no camera, microphone, geolocation or clipboard.
15. Adding the app breaks nothing: the five tools, two resources and two prompts behave exactly as
    before, and the existing 113 tests still pass.
16. The MCP server remains stateless — no view state, no session, nothing that would stop any
    replica answering any request.

## Verification

| Obligation | How |
|---|---|
| 1-5 | New `mcp-server/test/apps.test.ts`, driving a real MCP `Client` as `mcp-server.test.ts` does, on both eras |
| 4, 9, 10, 12, 15 | Same suite, against `stub-tasks-api.ts` |
| 6, 7 | Unit tests over the render function, extracted from the page the way `schema-form.ts` was extracted from `main.ts` — DOM-free logic, DOM-free tests |
| 8, 11, 13, 14 | By hand in a real host (Claude Desktop, or the `basic-host` example from the `ext-apps` repository). There is no automated path; see the note under *Where this can actually be seen* |
| 16 | `make scale REPLICAS=3`, then drive the board and confirm it works across replicas |

Obligation 9 deserves its own test written **before** the view is wired up, because it is the one
that fails silently — the board looks right and the data quietly loses a field.

## Open questions

1. **Should `mcp-client` learn to host apps?** `@modelcontextprotocol/ext-apps` ships an
   `./app-bridge` export that does iframe rendering, message passing and policy enforcement. It
   would make this repository both ends of the extension, which is a good exercise — and it is a
   separate spec, not a section of this one.
2. **`visibility: ["app"]`.** The extension can mark a tool callable by the app but hidden from the
   model. `tasks_update` is a candidate for a narrower app-only variant, which would let the board
   write without widening what the model itself can do. Deliberately out of scope here; worth its
   own decision once the simple version works.
3. **Does the Inspector render apps yet?** If it does, obligation 8's manual check gets much
   cheaper. Unchecked at the time of writing.
4. **`_meta.ui.prefersBorder` and `domain`.** Both appear in the specification's resource example
   and neither is understood well enough yet to set deliberately. Left unset.
