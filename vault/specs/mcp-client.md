# MCP client

**Status:** draft
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-23

> **Not implemented.** This is the design, agreed but unbuilt. Nothing in this file has been
> verified against running code — [Verification](#verification) is empty on purpose.
>
> **Fully specified.** All five open questions were decided by the owner on 2026-08-23;
> [Open questions](#open-questions) is now a decision record, not a list of things to settle
> during implementation.
>
> The measurements in [Feasibility](#feasibility-measured-2026-08-23) *were* taken, on 2026-08-23,
> before the design was written. They are the load-bearing ones: they are why this is a
> browser-only client and why `/mcp/client` does not break the existing `/mcp` route.

## Problem

There is no way to look at what [[mcp-server-typescript]] exposes without an external tool. Today
that means `make run-mcp-inspector`, which downloads a third-party debugger over the network,
opens on its own port, and defaults to the wrong protocol era — the whole reason obligation 20 of
that spec carries a caveat.

For seeing the five tools, reading their schemas, calling one, and watching the JSON-RPC that
results, a page served next to the server itself is a better answer than a general-purpose tool.

## Scope

- A **new module `mcp-client/`**, a peer of `task-api/` and `mcp-server/`, in TypeScript.
- A **browser page** served at **`http://localhost:8080/mcp/client`** through the existing nginx.
- It connects as a **real MCP client** on the **2026-07-28** revision, pinned — see
  [Modern only](#modern-only).
- Four things on the page: connection state, the tool list with descriptions, a form per tool
  generated from its `inputSchema`, and a message log of the JSON-RPC exchanges.
- One new nginx `location`, and static assets served from a bind mount.
- `make build`, `make test` and `make clean` extend to a third toolchain step.

**Non-goals:**

- **Any LLM.** This client is driven by a person clicking, not by a model. No `@anthropic-ai/sdk`,
  no `ANTHROPIC_API_KEY`. A chat client that lets Claude call these tools is a genuinely different
  piece of work with its own security surface and belongs in its own spec — the same argument
  [[mcp-server]] makes under *On the Anthropic SDK*, from the other side of the arrow.
- **Connecting to arbitrary MCP servers.** The endpoint is fixed to same-origin `/mcp`. That
  restriction is what buys the whole no-CORS, no-backend design; see [Open questions](#open-questions).
- **Replacing the MCP Inspector.** The Inspector has OAuth, stdio, sampling, elicitation,
  resources, prompts and a protocol-era switch. This has a tool list and a form. `make
  run-mcp-inspector` stays.
- MCP resources, prompts, subscriptions, sampling, elicitation. Tools only, matching what the
  server offers.
- Authentication. Same posture as everything else here: none.
- Changing `task-api`, `mcp-server`, or the tools themselves.

## Feasibility (measured 2026-08-23)

Two things had to be true before this design was worth writing down. Both were checked.

**1. The client SDK bundles for a browser.** `@modelcontextprotocol/client` 2.0.0 declares a
`browser` export condition. Bundled with `esbuild --bundle --platform=browser`, entry importing
`Client` and `StreamableHTTPClientTransport`:

| | size |
|---|---|
| raw | 608 KB |
| minified | 291 KB |
| minified + gzip | **77 KB** |

The package depends on `cross-spawn` for the stdio transport. Grepping the bundle for
`cross-spawn` and `child_process` returns **zero** hits — the browser condition and tree-shaking
keep the Node-only path out. Nothing had to be stubbed or aliased.

**2. `location /mcp/client` does not steal `/mcp`.** nginx picks prefix locations by longest match,
so the new location wins for its own paths and the existing one keeps everything else. Measured in
a throwaway nginx container with three locations and nothing else:

| request | matched |
|---|---|
| `/mcp/client` | **STATIC** |
| `/mcp/client/app.js` | **STATIC** |
| `/mcp` | PROXY-TO-MCP |
| `/mcp/` | PROXY-TO-MCP |
| `/tasks` | API |

This is the claim the existing `nginx.conf` comment already asserts for `/mcp` over `/`; here it is
confirmed one level deeper.

## Design

### Where the MCP connection lives: the browser

The page is served from `:8080/mcp/client` and the MCP endpoint is `:8080/mcp`. **Same origin.**
A `fetch` from the page to `/mcp` needs no CORS headers, no preflight, and no proxy of our own —
the custom `MCP-Protocol-Version` and `Mcp-Method` headers the modern era requires are
unrestricted on a same-origin request.

That is the entire justification for the `/mcp/client` path, and it is worth stating because the
alternative was real: a client on its own port (`:8888`, say) is cross-origin against `:8080/mcp`,
which would force either CORS headers on the MCP server — a change to a service this spec is meant
not to touch — or a Node backend whose only job is to relay. Neither is needed.

So: **no backend, no new container, no new port.** `mcp-client/` produces static files. nginx
serves them.

```
browser  ──GET  /mcp/client──▶  nginx ──▶  static files (bind mount)
   │
   └──POST /mcp────────────────▶  nginx ──▶  mcp replicas ──HTTP──▶  task-api
        (same origin, no CORS)
```

### Modern only

```ts
new Client(
    { name: 'tasks-mcp-client', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
```

Pinned, not `'auto'`. The requirement is the newest revision, and `pin` means exactly that: no
probe, no fallback, **anything else fails loudly**. Against a server that only spoke 2025-11-25
this client would refuse to connect rather than quietly downgrade — which is the behaviour we
want, and the opposite of the MCP Inspector's default that cost an investigation on 2026-08-23.

The consequence to accept: this client is useless against a legacy server. That is fine — it ships
next to a server it is guaranteed to match, in the same repository, behind the same proxy.

### Layout

```
mcp-client/
  package.json          esbuild + the client SDK; scripts make calls
  package-lock.json     committed, same reasoning as mcp-server
  tsconfig.json         browser lib, no "types": ["node"]
  src/
    main.ts             DOM wiring and the only file that touches document
    connection.ts       builds the Client, connects, exposes state. No DOM
    schema-form.ts      JSON Schema -> form model, and form values -> tool arguments. No DOM
    log.ts              the message log's data model. No DOM
    index.html          the shell the bundle attaches to
    style.css
  test/
    schema-form.test.ts
    log.test.ts
  dist/                 git-ignored build output; nginx bind-mounts this
```

**The DOM lives in exactly one file.** `main.ts` is the only module allowed to touch `document`;
everything else is pure functions over data. This is the same split as `http.ts` against
`index.ts` in [[mcp-server-typescript]], for the same reason — it is what lets the interesting
logic be tested by `vitest` in Node, with no browser and no Playwright. See
[Correctness obligations](#correctness-obligations) for what that does and does not buy.

### No UI framework

Plain TypeScript against the DOM. No React, no Vue, no component library.

The page has one list, one form and one log. A framework would be a larger dependency than the MCP
SDK itself and a build step more complicated than `esbuild src/main.ts --bundle`. This is the same
call `mcp-server` made in declining Express for two routes.

**Where this becomes wrong:** if the page grows tabs, resources, prompts, saved server profiles or
anything resembling the Inspector's surface. At that point re-open this decision rather than
hand-rolling a renderer. Record it here when it happens.

### Building

`esbuild`, one dev dependency, one command:

```
esbuild src/main.ts --bundle --format=esm --platform=browser --minify --outfile=dist/app.js
```

`tsc --noEmit` stays the typecheck, because esbuild strips types without checking them. Both run
under `make build-client`; a build that compiles but does not typecheck would defeat the point of
the language choice.

`index.html`, `style.css` are copied to `dist/` alongside `app.js`.

### Serving

nginx serves `dist/` from a **read-only bind mount**, exactly like `nginx/nginx.conf` today:

```yaml
  nginx:
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./mcp-client/dist:/usr/share/nginx/mcp-client:ro
```

Not baked into an image. The repository already made this choice for `nginx.conf`, and the
consequence is the same and is worth knowing: **the assets must exist on the host before `make up`**,
so `make build` has to have run. A missing mount surfaces as a 404 on the page, not as a container
that fails to start. `make up` therefore depends on `build-client`.

The new location, placed in the `8080` server block:

```nginx
        # LONGER prefix than /mcp below, so nginx matches this first -- verified, see the spec's
        # Feasibility section. `^~` makes that explicit rather than relying on the reader knowing
        # the longest-match rule, and stops any regex location added later from taking it.
        location ^~ /mcp/client {
            alias /usr/share/nginx/mcp-client;
            index index.html;
            try_files $uri $uri/ /mcp/client/index.html;
        }
```

`^~` is belt and braces: longest-prefix already wins, and the measurement above proves it, but the
next person adding a regex location should not be able to break this by accident.

**A consequence to accept:** a prefix location matches `/mcp/clientele` too. Nothing serves that
path today and nothing plans to; if it ever matters, split into `location = /mcp/client` plus
`location ^~ /mcp/client/`.

**Port 8877 gets nothing.** That listener is the MCP server's own front door and stays purely
protocol. The page lives on 8080 only.

### Makefile

```
build          -> build-api + build-mcp + build-client
build-client   -> npm ci && tsc --noEmit && esbuild ... && copy html/css
test           -> test-api + test-mcp + test-client
run-client     -> opens http://localhost:$(PORT)/mcp/client
clean          -> ... && rm -rf mcp-client/dist
```

`up` gains a dependency on `build-client`, for the bind-mount reason above.

## Correctness obligations

**Protocol**
1. The page connects and the negotiated protocol version is exactly `2026-07-28`, era `modern`.
2. Against a server that does not serve the modern era, the client **fails visibly** — a stated
   error on the page, not a silent downgrade and not a blank screen.
3. `tools/list` renders all five tools with their descriptions intact, including the `tasks_update`
   "NOT a patch" warning, which is the one a person most needs to read before using the form.
4. Calling a tool from the page has the same effect as calling it through any other MCP client:
   a task created here is visible in `GET :8080/tasks`.

**Schema to form** — pure logic, no DOM
5. Every argument type the five tools use produces a usable control: `string` a text field,
   an enum a select with exactly its allowed values, an optional field something that can be
   left unset.
6. **An omitted optional field is omitted from the arguments object, not sent as `""` or `null`.**
   This is the obligation with teeth: `tasks_update` resets what it is not sent, so a form that
   helpfully sends empty strings would silently rewrite tasks. It maps to [[task-api]] obligation
   14 and to obligation 6 of [[mcp-server-typescript]].
7. A required field left empty is refused by the page before a request is sent.

**Errors**
8. A tool result with `isError: true` is shown as the readable message the server sent, not as
   "request failed" and not as a raw JSON dump.
9. An unreachable MCP endpoint is distinguishable on the page from a tool that ran and failed.

**Log**
10. The log shows each exchange with method, direction and duration, and the count matches what
    nginx logged — no invisible extra requests.
11. `subscriptions/listen` is shown as an open stream rather than as a stuck request. This is the
    thing the Inspector gets right and a naive log gets wrong: it stays pending for the life of the
    connection by design.

**Routing and build**
12. `GET :8080/mcp/client` serves the page; `GET :8080/mcp/client/app.js` serves the bundle.
13. `POST :8080/mcp` still reaches the MCP server, and `GET :8080/tasks` still reaches the api.
    The new location must not have captured either.
14. `:8877` is unaffected and still serves protocol only.
15. `make build` builds three modules; `make clean` removes `mcp-client/dist`.
16. `make up` on a tree where `mcp-client/dist` does not exist gives a comprehensible failure, not
    a running stack that 404s at the page.

## Verification

**Not run — this spec is a draft and the client is not built.** Fill this in with the same shape as
[[mcp-server-typescript]]: a table of obligation, result, and the measured value where there is
one.

Which obligations the test suite can carry is already settled, so plan for it rather than
discovering it late. Obligations **5-9** are pure logic and belong in `vitest`. Obligations
**1-4** and **10-16** need a browser or a running stack, and the decision below is that they stay
**manual** for now. Say so in the table rather than implying coverage — the same honesty
[[QUALITY]] gaps 9 and 10 already apply to Docker and nginx. Add a gap for this one too when the
client ships.

## Open questions

None. All five were answered by the owner on 2026-08-23, each confirming the design above rather
than changing it.

| Was open | Decided |
|---|---|
| Editable endpoint, so the page can point at another MCP server? | **No — fixed to same-origin `/mcp`.** This is the one answer that would have undone the whole design: another origin means either CORS headers on the MCP server or a relay backend of our own. Use the Inspector for any other server |
| Serve the page on `:8877` as well? | **No — `:8080` only.** 8080 and 8877 are already two entrances to one backend, and obligation 14 of [[mcp-server-typescript]] exists precisely because that pair drifts. A third path to keep in step buys nothing; 8877 stays protocol-only |
| Bake the assets into the nginx image instead of bind-mounting? | **Bind mount**, matching how `nginx.conf` is already served. A UI change is then a bundle rebuild and a refresh rather than a `docker build`, and the nginx image stays the digest-pinned official one. The accepted cost is that `make up` depends on a prior build and a stale `dist/` is invisible |
| Playwright for obligations 1-4 and 10-16? | **Not now — those stay manual.** It would be the first browser test in this repository and deserves its own decision rather than arriving as a detail of this one. Record it as a known gap when the client ships |
| Does this retire `make run-mcp-inspector`? | **No — it stays.** The two cover different things: the Inspector has OAuth, stdio, resources, prompts, sampling and an era switch. Keeping it also keeps one *independent* client around — without it, a bug in this client has nothing to be checked against |

Record new questions here rather than deciding them silently in code.
