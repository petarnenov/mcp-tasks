# MCP prompts

**Status:** shipped
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-24

> **Shipped 2026-08-24.** All obligations verified — see [Verification](#verification). One
> obligation was **added during implementation** (7b) after a live probe found a hole the spec had
> not anticipated; see [Implementation notes](#implementation-notes).
>
> The third and last primitive. [[mcp-resources]] listed prompts under its non-goals as "a separate
> argument, its own spec if ever" — this is that spec, and the argument is in [Problem](#problem).
>
> It builds directly on the two resources that shipped on 2026-08-24: both prompts **embed** a
> resource rather than restating its data, so the same bytes reach the model through either door.
>
> Every SDK claim below was **executed**, not recalled — a probe against a real `McpServer` and a
> real `Client` on 2026-08-24, output quoted where it matters. Line references are into
> `mcp-server/node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs`.

## Problem

The server now offers things to *do* (five tools) and things to *read* (two resources). What it
does not offer is a way to start a piece of work — and starting is where the knowledge lives.

Concretely: "look at my task list and tell me what to do next" requires knowing that `tasks_list`
exists, that `status` is one of three values and `priority` of three others, that `tasks_update`
replaces rather than patches, and that the answer wanted is a ranking rather than a dump. Today all
of that has to be typed out by the person, every time, correctly. When they get it slightly wrong —
"just bump the priority on that one" — the model reaches for `tasks_update` and clears the
description, which is [[task-api]] obligation 14 arriving as a data loss.

A prompt is where that knowledge belongs: written once, on the server, next to the tools it talks
about, and offered to the client as a named starting point.

## Scope

- **Two prompts** on the MCP server:
  - `triage_tasks` — no arguments. Embeds `tasks://tasks` and asks for a triage and a ranking.
  - `plan_task` — one argument, `id`, **with completion**. Embeds `tasks://tasks/{id}` and asks for
    a breakdown into steps.
- `prompts` declared with **`listChanged: false`**, for the reason [[mcp-resources]] gives for
  resources: there is no instance to notify from.
- A **prompts panel** in the browser client: the prompt list, a form built from the declared
  arguments with completion, and the returned messages rendered — embedded resources included.
- New tests in both modules; `vault/QUALITY.md` counts updated.

**Non-goals:**

- **Prompts that write.** No prompt returns text that instructs a model to call a writing tool
  unprompted. See [Prompts share a connection with tools that write](#prompts-share-a-connection-with-tools-that-write)
  — this is the one non-goal here that is a safety property rather than a scope line.
- **Sampling and elicitation.** A prompt that asks the *server* to run a completion, or that
  interviews the user through the client, is a different mechanism with a different security
  surface. `input_required` stays unused.
- **User-authored or stored prompt templates.** These two are compiled in. A server that stores
  prompt text needs somewhere to store it, and this server owns nothing.
- **Changing tools, resources, `task-api`, nginx, ports, or the replica model.** No new route:
  prompts travel over the existing `/mcp`.
- **Prompt arguments richer than strings.** Not a choice — see [Arguments are strings, and only
  strings](#arguments-are-strings-and-only-strings).
- Authentication. Same posture as everything else here: none.

## Design

### The two prompts

| Name | Arguments | Embeds | Asks for |
|---|---|---|---|
| `triage_tasks` | none | `tasks://tasks` | Which tasks are in the wrong state, and the three worth doing next |
| `plan_task` | `id` (required, completing) | `tasks://tasks/{id}` | The concrete steps to finish that one task |

Both return a single `user` message pair: an instruction, then the data as an **embedded resource**.

```ts
{
    description: 'Triage the task list: wrong states, then what to do next.',
    messages: [
        { role: 'user', content: { type: 'text', text: TRIAGE_INSTRUCTION } },
        { role: 'user', content: { type: 'resource', resource: {
            uri: TASKS_URI, mimeType: 'application/json', text: /* the same JSON a read returns */,
        } } },
    ],
}
```

Verified end to end on 2026-08-24: a `type: 'resource'` block round-trips through `prompts/get`
with `uri`, `mimeType` and `text` intact, and so does a `resource_link`.

### Embedded, not linked

The alternative was `{ type: 'resource_link', uri: 'tasks://tasks' }` — hand the client a pointer
and let it read. Rejected, for two reasons and one that cuts the other way:

- **A link is only material if the client follows it.** Many do not; the prompt would then arrive
  as an instruction about a list the model cannot see, which is worse than no prompt at all.
- **`prompts/get` is already a point-in-time request.** The staleness a link would avoid is not
  avoided anyway: whatever the client does with the messages, it does after the call returns.
- Against: the embedded copy is a second place the task JSON exists on the wire. Accepted, and the
  URI it carries is the real one — a client that wants to re-read has the address.

The embedded text is byte-identical to what `resources/read` returns, and the **URI constants are
imported from `resources.ts`** rather than retyped. The JSON formatting is duplicated (one
`JSON.stringify(value, null, 2)`), and a test asserts the two agree — the same trade
[[mcp-resources]] made against `tasks_list`: duplicate one line, test the identity, do not couple
the modules.

### Prompts share a connection with tools that write

A client holding this connection has `tasks_update` and `tasks_delete` in the same session. Prompt
text that reads as an instruction to act *will* be acted on — that is what the model is for.

So both prompts say, in the instruction itself, that they are for thinking:

- `triage_tasks` ends with **"Do not change anything."** and asks for proposed changes to be
  *named*, including the reminder that `tasks_update` replaces the whole task, so every field must
  be passed back. That last clause is [[task-api]] obligation 14 written where it can prevent the
  data loss rather than explain it afterwards.
- `plan_task` ends with **"Do not create anything."** — `tasks_create` exists, and a plan is not a
  request to execute it.

This is a property to keep, not a phrasing to tidy. If a future prompt is meant to drive writes,
that is a different spec with a different argument, and the reason for the change belongs in it.

The exact text lives in `prompts.ts` as two named constants, so a diff to the instruction is
visible as a diff to the instruction.

### Arguments are strings, and only strings

`prompts/list` derives its `arguments` from the zod schema through
`promptArgumentsFromStandardSchema`, and what survives is exactly three fields. Measured:

```json
"arguments": [
  { "name": "id", "description": "a task id", "required": true },
  { "name": "note", "description": "optional note", "required": false }
]
```

**No type, no enum, no default.** A prompt argument is a string on the wire, and a client renders a
text box. This is why `plan_task` takes only `id`: an argument like `depth: 'shallow' | 'deep'`
would look like a choice in the schema and arrive at the client as free text, so the enum would be
enforced nowhere and advertised nowhere.

The `description` is therefore the only channel — same rule the tool descriptions live under, and
the reason `tasks_update`'s description is as long as it is.

A **missing required argument needs no code**: the SDK rejects it before the handler runs, with a
message a person can read. Measured verbatim:

```
-32602: Invalid arguments for prompt embed: id: Invalid input: expected string, received undefined
```

### Completion on `id`

```ts
argsSchema: z.object({
    id: completable(z.string().describe('...'), async (value) => /* ids with that prefix */),
})
```

`completable()` is a server-SDK export; the completion handler unwraps `.optional()` before
checking, so an optional completing argument would also work. Behaviour is the same as the resource
template's `id` and for the same reasons: **`[]` on any api failure, never a throw** — completion
fires per keystroke — and no slicing, since the SDK caps at 100 and computes `hasMore`.

The two completers are the same query against the same client. They stay two call sites rather than
one shared helper only if that reads better in the code; if a helper is written, it belongs in
`tasks-client.ts`, not in one primitive's file importing the other's.

### Errors: a third convention, and one trap

`tools.ts` never throws. `resources.ts` always throws. **`prompts.ts` throws too** — `GetPromptResult`
has no `isError` arm either — but not the same errors, and the difference is easy to get wrong:

| Case | Throw | Wire |
|---|---|---|
| `plan_task` with an id no task has | `ProtocolError(InvalidParams, …)` | `-32602`, **no `data`** |
| api unreachable | `ProtocolError(InternalError, …)` | `-32603` with the message |
| api returned some other status | `ProtocolError(InternalError, …)` | `-32603` with the message |

**The trap: do not throw `ResourceNotFoundError` for the unknown id.** It is right there in the
imports next door and it produces a `-32602` whose `data` is `{ uri }` — which is precisely how a
client is told *a resource is absent*. Our own browser client classifies exactly that shape as
not-found ([[mcp-resources]], obligation 16). A prompt that raised it would tell the client the
prompt does not exist, when what does not exist is a task the argument named. `InvalidParams`
without `data` is the honest answer: the argument was wrong and is worth retrying differently,
which is the same reading `tools.ts` gives a 400.

### Capabilities

`prompts: { listChanged: false }`, declared in `server.ts` beside the resources line. The SDK
defaults it to `true` (`mcp-DXXb3Vv3.mjs:1550`, the same `?? true` as resources), and this server
still builds one `McpServer` per request and discards it — nothing to notify from, nothing to
notify about, since the prompt text is compiled in and cannot change while the process runs.

`completions: {}` is declared by the SDK on its own as soon as a completable argument exists.
Measured: `{"completions":{},"prompts":{"listChanged":false}}`. It is already true today because of
the resource template, and it stays true; nothing to write.

### `prompts/list` does not call the task API

It cannot: the arguments come from the schema, and the api is only touched when a prompt is
actually fetched. Recorded as an obligation anyway, because the equivalent property for
`resources/list` had to be *designed* (the template's `list: undefined`) and someone reading both
files should see that this one is free rather than assume it was the same decision.

### The client panel

Third panel, same shape and same rules as the resources one:

```
mcp-client/src/prompts.ts       new — pure. View model from prompts/list, argument validation,
                                and the returned messages flattened for rendering.
mcp-client/src/connection.ts    listPrompts alongside listResources, behind the capability check.
mcp-client/src/main.ts          wiring only.
mcp-client/src/index.html       a fifth panel.
mcp-client/src/style.css        the panel.
```

- **Capability first.** No `prompts` capability → the panel says so and sends no request.
- **One text input per declared argument**, required ones marked, `description` as the hint —
  there is nothing else to render, per [Arguments are strings](#arguments-are-strings-and-only-strings).
  A required argument left blank is refused locally rather than sent, matching `schema-form.ts`.
- **Completion** through `client.complete({ ref: { type: 'ref/prompt', name }, argument: … })` into
  a `<datalist>`, the same as the template's `id`.
- **Messages render by role and block type**: text as text, `resource` as its URI plus its body,
  `resource_link` as its URI. An unknown block type is named, not swallowed — a client that
  silently drops content it does not understand is a client that lies about what the server sent.
- `textContent` throughout. Prompt text is server-supplied, and this one embeds task data written
  by whoever uses the api.
- The message log needs no change: `prompts/list`, `prompts/get` and `completion/complete` appear
  in it because it reads the method off the request body.

## Correctness obligations

Numbered to match test names, in **new** files — `mcp-server/test/prompts.test.ts` and
`mcp-client/test/prompts.test.ts` — per the one-spec-per-test-file rule in [[QUALITY]].

**Server**

1. `prompts/list` returns exactly the two prompts, each with a description; `triage_tasks` declares
   no arguments and `plan_task` declares `id` as required.
2. `prompts/list` sends **no** request to the task API, and answers while the api is unreachable.
3. `triage_tasks` returns an instruction message plus an embedded `tasks://tasks` resource whose
   text is byte-identical to `resources/read` on the same URI.
4. `plan_task` does the same for `tasks://tasks/{id}` and the id it was given.
5. The instruction text of `triage_tasks` tells the model not to change anything, and says
   `tasks_update` replaces every field. The instruction text of `plan_task` tells it not to create
   anything. **Asserted on the text**, because the property is the text.
6. `plan_task` with an id no task has fails with `-32602` and a readable message, and **without**
   `data.uri` — it must not be classifiable as a missing resource.
7. `plan_task` with the argument missing entirely fails with `-32602` before the handler runs, and
   sends no request to the task API.
7b. `plan_task` with an **empty** `id` is refused by the schema, and sends no request to the task
   API. Added 2026-08-24 — see [Implementation notes](#implementation-notes) note 1.
8. An unreachable task API fails with a readable message naming that cause, distinct from 6.
9. Completion on `plan_task`'s `id` suggests ids by prefix, and returns `[]` for a prefix matching
   nothing.
10. Completion returns `[]` — no throw — when the api is unreachable.
11. Declared capabilities include `prompts` with `listChanged: false`, and `completions`.
12. A 2025-era client can list and get both prompts.
13. Tools and resources are untouched: five tools, one resource, one template.

**Client**

14. The view model carries name, description and arguments, marking which are required.
15. A required argument left blank is refused locally, with the argument named; a filled form
    produces the arguments object `prompts/get` expects.
16. Messages flatten for rendering: text, embedded resource (URI **and** body), resource link, and
    an unknown block type reported rather than dropped.
17. A server whose capabilities omit `prompts` produces an empty view model and no requests.

**Deployment** — by hand, no automated coverage (the gap [[QUALITY]] records)

18. Through both entrances, `:8877/mcp` and `:8080/mcp`, both prompts list and get.
19. The browser client lists both, completes an `id`, gets `plan_task`, renders the embedded
    resource, and shows a made-up id as a readable argument error with the connection still green.
20. The MCP Inspector shows a Prompts tab with both, and gets one.

## Verification

Run **2026-08-24** against a live stack: api + 3 MCP replicas + nginx, all healthy.

| # | Obligation | Result |
|---|---|---|
| 1 | `prompts/list` is exactly the two, with their arguments | pass — `triage_tasks()`, `plan_task(id*)` |
| 2 | `prompts/list` does not call the api, and answers while it is down | pass |
| 3 | `triage_tasks` embeds `tasks://tasks`, byte-identical to a read | pass |
| 4 | `plan_task` embeds that one task, byte-identical to a read | pass |
| 5 | The instructions say not to write, and warn about full replace | pass — asserted on the text |
| 6 | Unknown id: `-32602`, **no** `data.uri` | pass — `data=undefined` |
| 7 | Missing argument fails before the handler | pass — no api request |
| 7b | Empty id refused by the schema | pass — `id: id must not be empty` |
| 8 | Unreachable api is a readable, distinct message | pass |
| 9 | Completion suggests ids by prefix | pass |
| 10 | Completion degrades to `[]` when the api is down | pass |
| 11 | `prompts.listChanged: false`, `completions` declared | pass — `{"prompts":{"listChanged":false},"completions":{}}` |
| 12 | A 2025-era client lists and gets | pass — negotiated `2025-11-25` |
| 13 | Tools and resources untouched | pass — 5 tools, 1 resource, 1 template |
| 14 | The client view model | pass |
| 15 | The form is checked locally | pass |
| 16 | Messages flatten, unknown types reported | pass |
| 17 | No prompt capability → no requests | pass |
| 18 | Both entrances list and get | pass — `:8877/mcp` and `:8080/mcp`, both eras |
| 19 | The browser client | pass — see below |
| 20 | The MCP Inspector | pass — CLI listed both and got `plan_task` |

**Obligations 1–17 are automated**: 14 vitest tests in `mcp-server/test/prompts.test.ts`, 11 in
`mcp-client/test/prompts.test.ts`. 18–20 were run by hand, the gap [[QUALITY]] records.

Obligation 19 in detail, driven through a real browser: the panel listed both prompts; pressing Get
with `id` blank was refused **locally** — no `prompts/get` in the message log; typing an id prefix
filled the datalist from `completion/complete`; getting `plan_task` rendered two blocks, the
instruction and the embedded resource labelled `tasks://tasks/52966587-…`; a made-up id rendered
"No task with id '…'" with the status badge still `connected` at `MCP 2026-07-28`; `triage_tasks`
rendered with **no** argument inputs and its no-write clause intact. Zero console errors.

Gates, from the repository root:

```
make test-mcp        # 40 tests (26 existing + 14 new)
make test-client     # 50 tests (39 existing + 11 new)
make test            # 113 across three modules
make build           # both toolchains
```

## Implementation notes

**1. An empty `id` was accepted, and the answer was silently wrong.** A live probe of
`plan_task` with `arguments: { id: '' }` returned **success**. `z.string()` accepts `""`, which
reached the api as `GET /tasks/` — and Micronaut answers that with the **whole list**, 200. The
prompt then embedded every task under the URI `tasks://tasks/` beneath an instruction to plan "this
one task". No error anywhere, at any layer.

The fix is `.min(1)` on the argument. What is worth keeping is why nothing else caught it: the
resource template is immune — `UriTemplate.match('tasks://tasks/')` returns `null`, so that path
is a clean not-found — and the browser client refuses a blank template variable before expanding.
Both protections live somewhere this prompt does not pass through. **A prompt argument is validated
only by its own schema.**

A whitespace-only id still reaches the api and comes back as the readable "No task with id '   '".
That is acceptable: it is an argument error reported as one.

**2. A test assertion was passing for the wrong reason.** Obligation 7 asserted the error message
matched `/id/`. It does — because "Inval**id** arguments" contains it, so the assertion would have
passed against any schema error at all. It now matches the actual sentence. Worth noting because
the test was green in the run that shipped the bug in note 1.

**3. `prompts/list` and `resources/list` are quiet for different reasons.** The resource listing is
quiet because the template registers `list: undefined` — a decision. The prompt listing is quiet
because arguments come off the schema and there is nothing to fetch. Obligation 2 exists to stop a
later reader assuming the second was designed like the first and "fixing" it.

## Open questions

| Question | Leaning |
|---|---|
| Should `triage_tasks` take an optional `focus` argument (a status or a word to narrow by)? | Not now. It would be free text advertised as free text, and the prompt already returns the whole list for the model to narrow itself. |
| Should the two completers share one helper? | Only if the code reads better for it. If so it goes in `tasks-client.ts` — `prompts.ts` importing from `resources.ts` for a query would couple two primitives through the wrong seam. |
| Does the client panel need to *send* a prompt anywhere? | No. This client has no LLM ([[mcp-client]] non-goals). It shows the messages; copying them out is the person's job. |
| A third prompt for writing (`draft_task` from free text)? | Deferred. It is the one useful prompt that touches no api, and it is also the first that would sit next to writing tools while describing a write — the argument in [Prompts share a connection](#prompts-share-a-connection-with-tools-that-write) has to be made properly, not by extension. |

Record new questions here rather than deciding them silently in code.
