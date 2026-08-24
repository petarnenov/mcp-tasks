# MCP client

**Status:** shipped
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-23

> **Shipped 2026-08-23.** All 16 obligations verified — see [Verification](#verification).
>
> **One decision changed during implementation.** Negotiation is `'auto'`, not pinned to
> 2026-07-28. The owner asked for it, and building the thing had already produced a second reason;
> see [Negotiation](#negotiation-auto-and-loud). Everything else shipped as specified.
>
> The measurements in [Feasibility](#feasibility-measured-2026-08-23) were taken before the design
> was written. They are the load-bearing ones: they are why this is a browser-only client and why
> `/mcp/client` does not break the existing `/mcp` route.

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
- It connects as a **real MCP client**, preferring the **2026-07-28** revision — see
  [Negotiation](#negotiation-auto-and-loud).
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
  server offers. **Revised 2026-08-24:** a resources panel shipped with [[mcp-resources]],
  alongside the two resources the server grew there. The rest remain out.
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

### Negotiation: auto, and loud

```ts
new Client(
    { name: 'tasks-mcp-client', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } },
);
```

**This changed during implementation**, on the owner's instruction (2026-08-23). The spec first
said `{ pin: '2026-07-28' }` — no probe, no fallback, fail loudly on anything older. Two things
argue against it, and the second was measured while implementing:

1. A pinned client cannot talk to a 2025-era server **at all**, which makes it useless as a
   debugging tool the moment it is pointed at anything but this repository's own server.
2. **Pinning does not even fail fast.** Against a stand-in that refuses `server/discover` the way
   the old Java implementation did, a pinned `connect()` sat for the full **60-second** probe
   timeout before rejecting — on HTTP the SDK treats silence as an outage rather than a legacy
   signal, so it retries rather than concluding. `'auto'` concludes and falls back.

`'auto'` probes `server/discover`, takes the modern era when it is offered, and falls back to the
2025 `initialize` handshake otherwise.

**The cost, and what is done about it.** `'auto'` is precisely the setting that let the MCP
Inspector display `LEGACY` against a server serving 2026-07-28 without anyone noticing — the thing
that started this whole line of work. A *silent* downgrade is the failure mode to avoid, not a
downgrade as such. So this client never downgrades silently:

- `Connection` reports the negotiated revision **and era** to the page.
- Anything other than `modern` renders in the **warning** state, reading
  `MCP 2025-11-25 — LEGACY era, not 2026-07-28`, rather than as an ordinary green connection.

Auto for reach, loud for honesty. Obligation 2 is what holds this to it.

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
1. Against this repository's server the page connects and negotiates exactly `2026-07-28`,
   era `modern`, shown in the connected state.
2. Against a server that does not serve the modern era, the client still connects — `'auto'` —
   but the downgrade is **visible**: the negotiated revision and era are stated on the page in the
   warning state, never rendered as an ordinary connection.
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
11. A long-lived channel is shown as an open stream, not as a stuck request and not as one that
    completed in milliseconds. This covers **both** eras: `subscriptions/listen` on 2026-07-28,
    and the body-less `GET` it replaced on 2025 — the second was found only by pointing the client
    at a real 1.x server, having shipped mislabelled.

**Routing and build**
12. `GET :8080/mcp/client` serves the page; `GET :8080/mcp/client/app.js` serves the bundle.
13. `POST :8080/mcp` still reaches the MCP server, and `GET :8080/tasks` still reaches the api.
    The new location must not have captured either.
14. `:8877` is unaffected and still serves protocol only.
15. `make build` builds three modules; `make clean` removes `mcp-client/dist`.
16. `make up` on a tree where `mcp-client/dist` does not exist gives a comprehensible failure, not
    a running stack that 404s at the page.

## Verification

Run 2026-08-23 against a live stack (api + 3 MCP replicas + nginx) and, for obligation 2, against a
purpose-built 2025-era server.

| # | Obligation | Result |
|---|---|---|
| 1 | Modern negotiated against our server | pass — header reads `tasks 0.1.0 · MCP 2026-07-28`, era `modern` |
| 2 | A downgrade is visible | pass — against a real SDK 1.30.0 server the page read `legacy-stand-in 9.9.9 · MCP 2025-11-25 — LEGACY era, not 2026-07-28` in the warning state, and still worked |
| 3 | Five tools, descriptions intact | pass — including `tasks_update`'s full "NOT a patch" warning |
| 4 | Round trip | pass — a task created from the page appeared in `GET :8080/tasks` |
| 5 | Every argument gets a control | pass — 26 vitest tests, against the server's real schemas |
| 6 | Blank optionals are omitted | pass — `{id, title}` only; no `""`, no `null` |
| 7 | Empty required refused before sending | pass — "Required and empty: id, title. Nothing was sent." |
| 8 | Tool error shown as its message | pass — "No task with id '…'. Call tasks_list to see valid ids." |
| 9 | Unreachable endpoint is distinguishable | pass — separate branch and separate message; covered by test |
| 10 | Log count matches nginx | pass — see [below](#how-obligation-10-was-actually-measured) |
| 11 | Open streams read as streaming | pass in **both** eras — `subscriptions/listen` and `GET (notification stream)` |
| 12 | Page and bundle served | pass — `/mcp/client/` 200 `text/html`, `app.js` 200 `application/javascript` |
| 13 | `/mcp` and `/tasks` unmoved | pass — both 200, MCP still negotiates 2026-07-28 |
| 14 | `:8877` unaffected | pass — protocol still served; `:8877/mcp/client` is 404 |
| 15 | `make build` / `make clean` | pass — three modules, 62 tests; `clean` removes both `dist/` |
| 16 | Missing build is comprehensible | pass — `up` depends on `build-client`, so the case cannot arise silently |

**Obligations 5-9 are automated** (26 vitest tests). 1-4 and 10-16 were driven by hand through a
real browser. There is still no browser test runner in this repository — see [[QUALITY]].

### How obligation 10 was actually measured

Counting nginx entries against the page's log looks trivial and is not: the two disagree by
design. nginx logs an entry when a response **completes**, and `subscriptions/listen` does not
complete while the connection is open.

Recorded before a fresh page load, then after: nginx logged **3** completed `POST /mcp`. The page
showed **3** exchanges — two complete and one streaming. The counts reconcile because the third
nginx entry is the *previous* page's stream closing on navigation, and its `urt="213.163"` says so:
213 seconds. That number is also the cleanest evidence for obligation 11 — a request nginx saw as
lasting three and a half minutes is not one that finished in 4ms.

## Implementation notes

**1. `task-api` answered the page's `/favicon.ico`.** With no icon declared, the browser asks for
`/favicon.ico`, which matches nginx's `location /` and is proxied to the **task API** — a 404 in
the console of a debugging tool, and a request the api has no business receiving. Fixed with an
inline `data:` icon in `index.html`; the page now loads with a clean console.

**2. nginx's directory redirect leaked the container's own port.** `GET /mcp/client` (no trailing
slash) 301s to `/mcp/client/`, and nginx built that `Location` **absolutely** from its `listen`
port. Under `PORT=9000 make up` the browser was sent to `http://localhost:8080/mcp/client/`, where
nothing is listening. Fixed with `absolute_redirect off`, which makes the redirect relative to
whatever origin the browser is already on. Both the bug and the fix were verified on 9000.

**3. `root`, not `alias`.** With `alias`, `try_files` resolves against the URI rather than the
aliased path and the fallback 404s. The mount point therefore mirrors the URL
(`/usr/share/nginx/html/mcp/client`), and `root` needs no such trick.

**4. `npm ci` refused to install, and `npm install` did not.** vitest brings a nested esbuild at a
different version from the direct one, and npm recorded that nested copy's platform packages in
the lockfile **without** `optional: true` — so `npm ci` treated `@esbuild/aix-ppc64` as required
and failed with `EBADPLATFORM` on arm64 macOS. `mcp-server` never hit this because it has no direct
esbuild to conflict with. Fixed by matching the direct dependency to vitest's version so one
hoisted copy serves both. **If a future dependency bump splits them again, this returns** — the
symptom is an unbuildable image, since the Dockerfile pattern in this repo installs with `npm ci`.

**5. The legacy notification stream was mislabelled, and only a real 1.x server showed it.** The
log correctly called `subscriptions/listen` streaming, then called the 2025 era's body-less `GET` —
the channel `subscriptions/listen` replaced — `complete 2ms`. Same bug, different era. This is why
`describeRequest` takes the HTTP verb as well as the body, and why obligation 11 now names both
eras. It was found by standing up a genuine SDK 1.30.0 server; no amount of testing against our own
server would have surfaced it.

## Open questions

None. All five were answered by the owner on 2026-08-23. One — the negotiation mode — was
**reopened and changed during implementation**; see [Negotiation](#negotiation-auto-and-loud).

| Was open | Decided |
|---|---|
| Pin to 2026-07-28, or negotiate? | **Superseded.** The spec said pin; the owner changed it to `'auto'` during implementation, and a measurement backed that up. The requirement "newest protocol" is met by *preferring* it and making any downgrade loud, not by refusing to connect |
| Editable endpoint, so the page can point at another MCP server? | **No — fixed to same-origin `/mcp`.** This is the one answer that would have undone the whole design: another origin means either CORS headers on the MCP server or a relay backend of our own. Use the Inspector for any other server |
| Serve the page on `:8877` as well? | **No — `:8080` only.** 8080 and 8877 are already two entrances to one backend, and obligation 14 of [[mcp-server-typescript]] exists precisely because that pair drifts. A third path to keep in step buys nothing; 8877 stays protocol-only |
| Bake the assets into the nginx image instead of bind-mounting? | **Bind mount**, matching how `nginx.conf` is already served. A UI change is then a bundle rebuild and a refresh rather than a `docker build`, and the nginx image stays the digest-pinned official one. The accepted cost is that `make up` depends on a prior build and a stale `dist/` is invisible |
| Playwright for obligations 1-4 and 10-16? | **Not now — those stay manual.** It would be the first browser test in this repository and deserves its own decision rather than arriving as a detail of this one. Record it as a known gap when the client ships |
| Does this retire `make run-mcp-inspector`? | **No — it stays.** The two cover different things: the Inspector has OAuth, stdio, resources, prompts, sampling and an era switch. Keeping it also keeps one *independent* client around — without it, a bug in this client has nothing to be checked against |

Record new questions here rather than deciding them silently in code.
