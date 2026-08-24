# MCP resources

**Status:** shipped
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-24

> **Shipped 2026-08-24.** All 20 obligations verified — see [Verification](#verification).
> Implemented as specified; the two departures from the written design are recorded under
> [Implementation notes](#implementation-notes).
>
> Extends [[mcp-server-typescript]], which listed resources under its non-goals. That line is what
> this spec revises; everything else in it — the two eras, the per-request server instance, the
> stateless-proxy argument — is inherited unchanged and not re-argued here.
>
> Every SDK claim below was checked against the installed packages on **2026-08-24**, not recalled.
> Line references are into `mcp-server/node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs`.

## Problem

The MCP server offers five tools and nothing else. Everything a client can learn about the task
list, it learns by *calling* something.

That is the wrong shape for two of the three things people actually do with this server:

- **Attaching context.** A person driving a client wants to hand a conversation "the task list" or
  "this one task" as material, without the model deciding to call a tool and without the call
  showing up as an action it took. MCP's answer to that is a resource: a URI you read.
- **Browsing.** Our own client at `:8080/mcp/client` can only show what `tools/list` returns. There
  is no way to look at the data the server sits in front of without filling in a form and pressing
  Call — which writes a tool call into the message log for what is a read.

Tools remain the right shape for the third thing, a model doing work. Nothing here replaces them.

## Scope

- **Two resources** on the MCP server:
  - `tasks://tasks` — the whole task list, static URI.
  - `tasks://tasks/{id}` — one task, a `ResourceTemplate`, with **completion** on `id`.
- `resources` declared with **`listChanged: false`** and **no `subscribe`** — see
  [Capabilities](#capabilities-listchanged-false-said-out-loud).
- A **resources panel** in the browser client at `/mcp/client`: the resource list, the template with
  a completing `id` field, and the read body. Errors rendered as a missing resource, not as a broken
  connection.
- New tests in both modules; `vault/QUALITY.md` test counts updated.

**Non-goals:**

- **`resources/subscribe` and `notifications/resources/list_changed`.** Structurally impossible here,
  not merely unimplemented — see [Capabilities](#capabilities-listchanged-false-said-out-loud).
- **Prompts.** A third primitive, a separate argument, its own spec if ever.
  **2026-08-24:** written and shipped — [[mcp-prompts]]. Both prompts there embed the two
  resources specified here.
- **Changing or removing any tool.** `tasks_list` and `tasks_get` stay exactly as they are; the
  overlap is deliberate and argued under [Why this duplicates two tools](#why-this-duplicates-two-tools).
- **`resource_link` content blocks in tool results.** Worth considering later; it changes what tools
  return, which is a bigger blast radius than adding a read-only surface beside them.
- **Binary contents, pagination, `annotations`, `size`.** The list is small and the payload is JSON.
- **Touching `task-api`, nginx, ports, or the replica model.** No new route: resources travel over
  the existing `/mcp` endpoint.
- Authentication. Same posture as everything else here: none.

## Design

### The two URIs

| Name | URI | Kind | Content |
|---|---|---|---|
| `tasks` | `tasks://tasks` | static | `GET /tasks` verbatim, pretty-printed |
| `task` | `tasks://tasks/{id}` | template | `GET /tasks/{id}` verbatim, pretty-printed |

A custom `tasks://` scheme rather than `http://`: these are not fetchable URLs, and giving them an
`http` scheme invites a client to try. The member sits *under* the collection so the relationship
reads without explanation.

**The scheme was checked against the SDK's lookup, not assumed.** `resources/read` does
`new URL(request.params.uri)` and then an **exact string lookup** of `_registeredResources[uri.toString()]`
before it tries any template (`mcp-DXXb3Vv3.mjs:1522-1541`). A scheme that normalized — a trailing
slash appearing, a host being lowercased — would leave the static resource unreachable or route a
read into the wrong handler. Measured 2026-08-24 on Node 24:

```
new URL('tasks://tasks').href            === 'tasks://tasks'          // round-trips
new URL('tasks://tasks/abc-123').href    === 'tasks://tasks/abc-123'  // round-trips
UriTemplate('tasks://tasks/{id}').match('tasks://tasks/abc-123')  -> { id: 'abc-123' }
UriTemplate('tasks://tasks/{id}').match('tasks://tasks')          -> null
```

The template does **not** match the collection, so the two never contend. Ids live in the path,
which `URL` leaves alone — only the host is lowercased, and ours is the constant `tasks`.

Content shape, both resources:

```ts
{ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] }
```

Same pretty JSON the tools produce, so reading `tasks://tasks/{id}` and calling `tasks_get` yield
byte-identical text. That is worth keeping: a person comparing the two should not have to wonder
whether a formatting difference is a data difference.

### Errors: this file throws, and the file next to it must not

`tools.ts` opens with a rule — never throw, return `isError: true` with something readable. **The
resource handlers invert it**, and `resources.ts` will say so at the top, because a reader arriving
from the neighbouring file will otherwise read the throws as a bug.

The reason is that `ReadResourceResult` has no error arm. There is no `isError` on a resource read;
a miss can only be reported as a JSON-RPC error. Inventing a 200 with `{"error": ...}` in the body
would be worse than throwing: a client caches it as content and a model reads a task that says
"not found".

- **Unknown id** → `throw new ResourceNotFoundError(uri.href)`. It crosses the wire as **`-32602`
  Invalid Params with `data: { uri }`** on *both* eras — the SDK never emits `-32002`, and a
  handler-thrown `-32002` is remapped at the era encode seam (the 2026-07-28 spec MUST; the enum
  member survives only so clients can recognise the old code from older peers).
- **Unreachable api, or any other status** → `throw new ProtocolError(ProtocolErrorCode.InternalError, …)`
  with the same two messages the tools use. A `ProtocolError` carries its message to the wire; a
  bare `Error` is exactly the opaque `-32603` that `tools.ts`'s first implementation note warns
  about. The distinction between "the api said 500" and "the api could not be reached" is preserved
  here for the same reason it exists there.

`TasksClient` needs no change: `ApiResult` already forces the failure arm to be handled, and the
`{ ok: false, kind }` union maps onto the two throws above.

### Capabilities: `listChanged: false`, said out loud

Registering any resource makes the SDK declare the capability for you, and it defaults
`listChanged` to **true**:

```js
this.server.registerCapabilities({ resources: { listChanged: this.server.getCapabilities().resources?.listChanged ?? true } });   // mcp-DXXb3Vv3.mjs:1497
```

**This server can never send that notification.** `createMcpHandler` builds one `McpServer` per
request and discards it; there is no instance holding a connection to notify on, and no way to learn
that a task changed anyway — writes go through the api, which does not call us. Advertising
`listChanged: true` makes a client open a `subscriptions/listen` stream and wait for refreshes that
cannot arrive. Our own client would do exactly that: it already opts into list-change handling for
tools.

So `server.ts` grows an options argument:

```ts
new McpServer(SERVER_INFO, { capabilities: { resources: { listChanged: false } } })
```

The `?? true` above is what makes this work — an explicitly-set `false` is preserved. `subscribe` is
left undeclared for the same structural reason.

This is the first time the per-request-instance property has cost anything rather than only paying
out. Worth recording as such: it is still the right trade, and the price is a notification nobody
here can use.

### `resources/list` does not call the task API

The template is registered with **`list: undefined`**. The `ResourceTemplate` constructor requires
the key to be present even when undefined, "to avoid accidentally forgetting resource listing" — so
this is a decision the SDK forces you to write down, and here is why it is `undefined`:

- The alternative enumerates every task as its own entry, which puts a `GET /tasks` — **and an api
  outage** — inside `resources/list`. The listing handler awaits the callback and has no failure arm
  (`mcp-DXXb3Vv3.mjs:1504-1513`), so an api that is down would take out the listing of the static
  resource too.
- Nothing becomes undiscoverable. `tasks://tasks` *is* the list of ids, one read away, and the
  template is advertised through `resources/templates/list` with completion on `id`.

Consequence, stated so it is not read as a bug: `resources/list` returns exactly **one** entry.

### Completion on `id`

`complete: { id }` on the template answers `completion/complete` with the ids that start with what
has been typed:

- On any api failure it returns **`[]`**, never throws. Completion fires on keystrokes; an outage
  should degrade to no suggestions, not to an error dialog per character.
- No slicing or `hasMore` bookkeeping — the SDK caps at 100 and computes `hasMore` itself
  (`createCompletionResult`, `mcp-DXXb3Vv3.mjs:1903`).
- It is a convenience, not a contract: a client that ignores completion still works, and the ids it
  suggests came from the same `GET /tasks` a read would use.

### No cache hint

No `cacheHint` on either registration. The 2026-07-28 default for cacheable results is
`ttlMs: 0, cacheScope: 'private'` — nothing is held — and that is the right answer here: tasks are
mutable by anyone with the api, this server cannot know when, and a stale task is a failure a model
has no way to detect. A round trip we can afford is not worth trading for it. 2025-era responses
never carry cache fields at all.

### Why this duplicates two tools

`tasks://tasks` returns what `tasks_list` returns. That is not an oversight:

- A **tool call is an action** — the model chose it, it appears in the transcript as something the
  model did, and a client may gate it behind approval. A **resource read is material** — a person or
  a client attaches it, and the model simply has it.
- The audiences differ. Tools are the model's hands. Resources are the client's clipboard.

The rule for keeping them honest: **resources are read-only and stay read-only.** Nothing that
writes ever gets a URI. If that ever stops being true, this section is the thing that was violated.

### The client panel

Same split `main.ts` already states: logic in a pure module, DOM only in `main.ts`.

```
mcp-client/src/resources.ts     new — pure. View model from resources + templates; variable
                                names and expansion via UriTemplate; error classification.
mcp-client/src/connection.ts    listResources / listResourceTemplates / readResource / complete,
                                plus an onResources handler alongside onTools.
mcp-client/src/main.ts          wiring only.
mcp-client/src/index.html       a fourth panel.
mcp-client/src/style.css        the panel.
```

- **Capability first.** If `client.getServerCapabilities()?.resources` is undefined, the panel says
  the server exposes no resources and makes **no** request. Negotiation is `'auto'` and this client
  is a debugging tool; it must not throw `-32601` at a server that simply has no resources — nor at
  our own server during the rollout, before this ships.
- **A static resource** is one click: `readResource({ uri })`, body into a `<pre>`.
- **A template** renders one input per `UriTemplate(...).variableNames` (`UriTemplate` is a public
  export of `@modelcontextprotocol/client`), backed by a `<datalist>` filled from
  `client.complete({ ref: { type: 'ref/resource', uri: template }, argument: { name, value } })`.
  Submit expands with `UriTemplate.expand` and reads.
- **A miss is not a broken connection.** `ResourceNotFoundError` is re-exported by the client SDK and
  its `instanceof` is brand-matched across separately bundled copies; the fallback check is a
  `-32602` whose `data` is exactly `{ uri }`. Either way it renders in the panel as "no resource at
  `<uri>`", and the connection badge stays green.
- **`textContent`, never `innerHTML`** — resource bodies come off the wire, same rule and same reason
  as tool descriptions.
- **The message log needs no change.** It names the JSON-RPC method out of the request body, so
  `resources/list`, `resources/read` and `completion/complete` appear beside `tools/call` for free.

## Correctness obligations

Numbered to match test names. Server obligations live in a **new** file
`mcp-server/test/resources.test.ts` rather than being appended to `mcp-server.test.ts`, whose numbers
belong to [[mcp-server-typescript]] — two specs numbering into one file is how a failing test stops
naming the obligation that broke.

**Server** — `mcp-server/test/resources.test.ts`

1. `resources/list` returns exactly one resource, `tasks://tasks`, with a name and
   `mimeType: application/json`.
2. `resources/list` sends **no** request to the task API (asserted on the stub's request log), and
   still answers when the api is unreachable.
3. `resources/templates/list` returns exactly one template, `tasks://tasks/{id}`.
4. Reading `tasks://tasks` returns every task, as JSON text identical to what `tasks_list` returns.
5. Reading `tasks://tasks/{id}` returns that one task, identical to `tasks_get`.
6. Reading an unknown id raises `ResourceNotFoundError` at the client: wire code **-32602**, `data`
   exactly `{ uri }` — not `-32002`, not a 200 with an error body, not a stack trace.
7. Reading a URI matching no resource or template raises the same error.
8. With the api unreachable, a read raises an error whose **message is readable** and says the api
   could not be reached — distinct from obligation 6 and from a bare `-32603`.
9. Completion on `id` returns the ids that start with the typed prefix, and `[]` for a prefix that
   matches nothing.
10. Completion returns `[]` — and does not throw — when the api is unreachable.
11. Declared capabilities include `resources` with **`listChanged: false`** and **no** `subscribe`.
12. A 2025-era client can list and read both resources. The resource surface is not modern-only.
13. Registering resources does not disturb the tools: `tools/list` still returns exactly five, and a
    round-trip through `tasks_create` is still visible through `tasks://tasks`.

**Client** — `mcp-client/test/resources.test.ts` (pure module, no DOM)

14. The view model separates static resources from templates and carries name, uri and mimeType.
15. Variable names are read off the template, and expansion produces the URI a read would use,
    percent-encoding an id that needs it.
16. A `-32602` with `data: { uri }` classifies as resource-not-found; a `-32602` without it, and an
    ordinary transport failure, do not.
17. A server whose capabilities omit `resources` produces an empty view model and no requests.

**Deployment** — by hand, no automated coverage (the same gap [[QUALITY]] records)

18. Through both entrances, `:8877/mcp` and `:8080/mcp`, both resources list and read.
19. The browser client at `:8080/mcp/client` lists both, reads the collection, completes an `id`,
    reads that task, and shows a made-up id as a missing resource with the connection still green.
20. The MCP Inspector shows a Resources tab with both entries.

## Verification

Run **2026-08-24** against a live stack: api + 3 MCP replicas + nginx, all healthy.

| # | Obligation | Result |
|---|---|---|
| 1 | `resources/list` is exactly the collection | pass |
| 2 | `resources/list` does not call the api, and answers while it is down | pass — request count unchanged, and an offline server still lists |
| 3 | `resources/templates/list` is exactly the template | pass |
| 4 | The collection reads identically to `tasks_list` | pass — byte-identical |
| 5 | A task reads identically to `tasks_get` | pass — byte-identical |
| 6 | Unknown id is resource-not-found | pass — `-32602`, `data: { uri }`, `ResourceNotFoundError` at the client |
| 7 | A URI matching nothing is the same error | pass |
| 8 | Unreachable api is a readable, distinct message | pass — "Could not reach the task API…" |
| 9 | Completion suggests ids by prefix | pass |
| 10 | Completion degrades to `[]` when the api is down | pass — no throw |
| 11 | `resources.listChanged: false`, no `subscribe` | pass |
| 12 | A 2025-era client lists and reads | pass — negotiated `2025-11-25`, era `legacy` |
| 13 | The five tools are untouched | pass |
| 14 | The client view model | pass |
| 15 | Variables read off the template, expansion encodes | pass |
| 16 | Not-found told apart from a broken client | pass |
| 17 | No resource capability → no requests | pass — call log empty |
| 18 | Both entrances list and read | pass — `:8877/mcp` and `:8080/mcp`, era `modern`, both eras through the proxy |
| 19 | The browser client | pass — see below |
| 20 | The MCP Inspector | pass — CLI listed both and read the collection |

**Obligations 1–17 are automated**: 13 vitest tests in `mcp-server/test/resources.test.ts`, 12 in
`mcp-client/test/resources.test.ts`. 18–20 were run by hand, the same gap [[QUALITY]] records.

Obligation 19 in detail, driven through a real browser: the panel listed `tasks://tasks` and
`tasks://tasks/{id}`; clicking the collection read 11 tasks; typing an id prefix produced
`completion/complete` per keystroke and the datalist held the matching UUID; reading the completed
id returned that task; reading a **prefix** — a URI that genuinely does not exist — rendered "No
resource at tasks://tasks/52966587." while the status badge stayed `connected` at
`MCP 2026-07-28`. Zero console errors. `resources/list`, `resources/templates/list`,
`resources/read` and `completion/complete` all appeared in the message log without the log
knowing anything about resources.

Gates, all from the repository root:

```
make test-mcp        # 26 tests (13 existing + 13 new)
make test-client     # 39 tests (26 existing + 13 new)
make test            # 88 across three modules
make build           # both toolchains
```

## Implementation notes

**1. The listing failure had to bypass `onError`.** The first cut reported a failed
`resources/list` through the connection's `onError` handler, whose only wiring in `main.ts` turns
the status badge red. That would have said the connection was broken when the connection was fine
and every tool still callable — the exact misreport the panel's not-found handling exists to
avoid, reintroduced one layer up. `onResources` grew an optional `error` argument instead, and the
message lands in the panel.

**2. The capability guard became a pure function, because otherwise obligation 17 was untestable.**
"Asks for nothing when the server declares no resources" was a claim about a private method on
`Connection`. `loadResources(client)` in `mcp-client/src/resources.ts` takes a structural
`ResourceReader` — the real `Client` satisfies it, and so does a call-counting stand-in — so the
obligation is now an assertion on an empty call log rather than an argument about the code's shape.

**3. `#resource-body` needed a third state.** `.result[data-error]` is a boolean in the CSS, and a
resource that is absent is neither success nor failure: the server worked correctly. It renders
with the warning colour, distinct from a red transport failure.

## Open questions

| Question | Leaning |
|---|---|
| A third resource `tasks://tasks/open` (TODO + IN_PROGRESS)? | Not now. The api has no filtering, so the filter would live here and this server would stop being a pure proxy. Revisit if the list gets long enough that reading all of it is the problem. |
| Should tools return `resource_link` blocks pointing at these URIs? | Deferred. It is the natural next step and it changes what every tool returns; its own spec. |
| Should the client's resources panel share the `#result` element with the call panel? | No — a read and a call are different things and the log already interleaves them. Separate `<pre>`. Decided and shipped. |
| Should completion be debounced? | Open. It fires per keystroke today — 8 typed characters produced 8 `completion/complete` round trips at 25-50ms each. Harmless against a local api and honest in the message log, which is half of what this client is for. Revisit if it is ever pointed at something slower. |

Record new questions here rather than deciding them silently in code.
