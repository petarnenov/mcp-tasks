# Nginx front door

**Status:** shipped
**Owner:** petarnenovpetrov@gmail.com
**Updated:** 2026-08-23

> **Shipped 2026-08-23.** All 20 obligations verified against a running stack.
>
> **Read [The constraint](#the-constraint-sqlite-takes-one-writer) before anything else.** The
> request was for a load balancer; what this delivers is a *reverse proxy with one backend*,
> because SQLite cannot safely take two writers. That trade was confirmed by the owner.
>
> One design detail changed during implementation — see
> [Implementation notes](#implementation-notes).

## Problem

The service is published straight from the application container: `compose.yaml` maps
`${PORT:-8080}:8080` on the `api` service, and Micronaut's Netty server faces the host directly.

That works, but it means there is no place to put anything that is not application logic. No access
log in a standard format, no request size or rate limiting, no timeouts independent of the JVM, no
single place to terminate TLS later, and no way to change what is behind port 8080 without
restarting the application container.

## The constraint: SQLite takes one writer

A load balancer implies several backends sharing work. **This application cannot currently be run
as several backends**, and that is deliberate rather than an oversight:

- `application.yml` sets `maximum-pool-size: 1` — see the Decisions section of
  [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
- [[docker-and-make]] lists horizontal scaling as an explicit **non-goal**: *"`docker compose up
  --scale` is unsupported and unsafe: SQLite takes one writer and the pool is deliberately sized
  at 1."*

Running two `api` containers against the same `data/tasks.db` is worse than slow. Both would hold
the file open through a **bind mount**, which on Docker Desktop is virtiofs and on Linux may be any
filesystem the user happens to have. SQLite's own documentation warns against database files on
network or shared filesystems precisely because its locking depends on POSIX advisory locks
behaving correctly, and the observed failure is not a clean error — it is `SQLITE_BUSY` under light
load and **database corruption** under unlucky timing.

So this spec ships nginx as a **single front door in front of one backend** (confirmed
2026-08-23). Real load balancing across replicas remains possible, but it starts with replacing
SQLite — realistically Postgres — and is a separate spec that begins at the database, not at the
proxy. Nothing here pretends the proxy alone buys throughput.

**What nginx does buy at one replica**, which is why it is still worth doing: a stable public port
decoupled from the app container, combined access logging, request limits, connection timeouts that
do not depend on Netty, a place for TLS later, and the ability to restart or replace the backend
without the published port going away.

## Scope

- An `nginx` service in `compose.yaml`, publishing **`${PORT:-8080}` on the host**.
- `api` **stops publishing a host port**. It becomes reachable only on the Compose network.
- `nginx/nginx.conf` in version control, mounted read-only into the container.
- Runtime DNS resolution so a restarted backend does not strand nginx on a dead IP.
- `X-Forwarded-*` and `Host` headers, so the application sees the real client rather than the proxy.
- A healthcheck for nginx that does **not** depend on the backend being up, plus `depends_on` so
  nginx starts after `api` is healthy.
- Makefile: `make logs` follows both services; new `make logs-api` / `make logs-nginx`.

**Non-goals:**
- **More than one `api` replica.** Fixed at 1, enforced by `container_name`. See
  [The constraint](#the-constraint-sqlite-takes-one-writer).
- TLS / HTTPS. Port 8080 is plain HTTP. The point of nginx here is having somewhere to *put* TLS
  later, not configuring it now.
- Caching responses. `GET /tasks` has no cache headers and no pagination; caching it would serve
  stale task lists for no real gain.
- Log files on disk. Nginx logs go to stdout and are read with `make logs` (confirmed 2026-08-23):
  one place to look, no rotation to maintain, and no second bind mount to hit the UID trap. They
  do not survive `make down`.
- Rate limiting tuned to real traffic. The mechanism is wired and tested at a deliberately
  generous `100r/s` (confirmed 2026-08-23), so the config is in place and tightening it later is
  one number rather than a new feature.
- Auth, WAF, IP allow-lists, request rewriting.
- Replacing the app's own `/health`. Nginx gets its own liveness endpoint; the app keeps its.

## Design

### Topology

```
host :${PORT:-8080}
        |
        v
   [ nginx ]  nginx:alpine, digest-pinned, conf mounted read-only
        |     proxy_pass -> http://api:8080   (runtime DNS)
        v
   [  api  ]  no published port; only on the compose network
        |
        v
   ./data/tasks.db   bind mount, one writer
```

### nginx/nginx.conf

```nginx
worker_processes auto;

events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/json;

    # Combined plus upstream timing, so a slow response is attributable to the app or the proxy.
    log_format  upstream_time  '$remote_addr - $remote_user [$time_local] "$request" '
                               '$status $body_bytes_sent "$http_referer" "$http_user_agent" '
                               'rt=$request_time uct="$upstream_connect_time" '
                               'urt="$upstream_response_time"';
    access_log  /var/log/nginx/access.log  upstream_time;

    sendfile      on;
    server_tokens off;

    # The app caps description at 2000 chars; 1 MB is already far above any legitimate request.
    client_max_body_size 1m;

    # Generous on purpose (confirmed 2026-08-23): does not restrict local use, but the
    # mechanism is live and tested, so tightening it later is a single number.
    limit_req_zone $binary_remote_addr zone=api:10m rate=100r/s;

    # Docker's embedded DNS. `valid=10s` re-resolves rather than caching a dead IP forever.
    resolver 127.0.0.11 valid=10s ipv6=off;

    server {
        listen 8080;
        server_name _;

        # Nginx's own liveness, deliberately public on the same port (confirmed 2026-08-23):
        # one curl then tells you which layer is down. It does NOT touch the backend -- this
        # answers "is the proxy up", the app's /health answers "is the app up". Conflating
        # them makes a backend restart look like a proxy failure.
        location = /nginx-health {
            access_log off;
            add_header Content-Type application/json;
            return 200 '{"status":"UP","service":"nginx"}';
        }

        location / {
            limit_req zone=api burst=200 nodelay;

            # proxy_pass through a VARIABLE, not a literal. With a literal hostname nginx
            # resolves once at startup and caches forever -- a restarted api container comes
            # back on a new IP and every request 502s until nginx is reloaded. A variable
            # forces resolution at request time using the resolver above.
            set $upstream_api http://api:8080;
            proxy_pass $upstream_api;

            proxy_http_version 1.1;
            proxy_set_header Host              $host;
            proxy_set_header X-Real-IP         $remote_addr;
            proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Connection        "";

            proxy_connect_timeout 5s;
            proxy_send_timeout    30s;
            proxy_read_timeout    30s;
        }
    }
}
```

**On `Location` headers.** `TaskController.create` returns a *relative* `Location: /tasks/{id}`
(see [[task-api]]). That happens to be exactly right behind a proxy — an absolute URL built from
the container's internal hostname would leak `http://<container-id>:8080/...` to the client. Do not
"improve" it into an absolute URI without adding host resolution config.

### compose.yaml changes

```yaml
services:
  api:
    # ports: REMOVED. Reachable only on the compose network now.
    expose:
      - "8080"
    # ... everything else unchanged

  nginx:
    image: nginx:alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913
    container_name: tasks-nginx
    depends_on:
      api:
        condition: service_healthy
    ports:
      - "${PORT:-8080}:8080"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8080/nginx-health"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 5s
```

Notes:

- **The conf is mounted `:ro`,** not baked into an image. It stays a reviewable file in git, and
  editing it needs only `docker compose restart nginx` rather than an image rebuild.
- **`depends_on: condition: service_healthy`** means nginx does not start until the app answers
  `/health`. Without it nginx comes up first and the first few requests 502.
- **`curl` in the healthcheck, not `wget`.** The spec assumed the Alpine image had only busybox
  `wget`. It was wrong: `nginx:alpine` ships a real `curl` 8.21.0 binary (verified). Using it keeps
  both healthchecks in `compose.yaml` spelled the same way.
- **`container_name: tasks-api` on the api service becomes a scaling blocker.** Compose refuses to
  create more than one container with a fixed name, so `--scale api=2` fails outright. That is
  currently a *feature* — it makes the unsafe thing impossible rather than merely discouraged. If
  replicas are ever wanted, that line has to go, and the storage question has to be answered first.

Pinned 2026-08-23 to **nginx 1.31.4 on Alpine 3.24**:

| Image | Digest |
|---|---|
| `nginx:alpine` | `sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913` |

Re-resolve with `docker buildx imagetools inspect nginx:alpine`.

### Makefile changes

```makefile
logs:  ## Follow logs from all services
	$(COMPOSE) logs -f

logs-api:  ## Follow the application logs only
	$(COMPOSE) logs -f api

logs-nginx:  ## Follow the nginx access and error logs only
	$(COMPOSE) logs -f nginx

nginx-reload:  ## Reload nginx.conf without restarting anything
	$(COMPOSE) exec nginx nginx -t
	$(COMPOSE) exec nginx nginx -s reload
```

`make shell` keeps opening a shell in `api`, which is the one people mean. `make up`, `make down`,
`make ps` and the `PORT` override are unchanged in spelling — `PORT` now controls nginx's published
port instead of the app's, which is invisible from the outside.

## Correctness obligations

**Routing**
1. `curl localhost:8080/tasks` returns the same result it did before nginx existed — all five
   endpoints work through the proxy, including `POST` with a body and `DELETE`.
2. `POST /tasks` still returns `201` with a **relative** `Location` header, and following that
   header through the proxy resolves to the created task.
3. The api container is **not** reachable directly from the host on any port.
4. A `404` from the application arrives at the client as the application's JSON body, not as an
   nginx error page.
5. A `400` from validation arrives unchanged. Nginx does not rewrite application error responses.

**Headers**
6. The application receives `X-Forwarded-For` containing the real client address, not the nginx
   container's.
7. `Host` reaches the application as the host the client asked for.

**Resilience**
8. Restarting only the api container (`docker compose restart api`) does **not** leave nginx
   permanently 502-ing. This is the DNS caching trap: it must recover within the resolver's
   `valid=10s` window without an nginx reload.
9. While the api container is down, nginx returns 502 promptly rather than hanging until a client
   timeout.
10. `/nginx-health` returns 200 **even when the api container is stopped** — it reports the proxy,
    not the backend.
11. Nginx does not start serving before the api is healthy (`depends_on` + `condition`).

**Compose & Make**
12. `make up` brings up both services and both report `healthy` in `make ps`.
13. `PORT=9000 make up` publishes nginx on 9000; nothing listens on 8080.
14. `make down` stops both and leaves `./data` intact.
15. `make logs` shows output from both services; `make logs-api` and `make logs-nginx` each show one.
16. `make nginx-reload` validates the config first and fails loudly on a syntax error rather than
    reloading a broken config.
17. `docker compose config -q` is silent — no warnings, no `version:` key.

**Safety**
18. `docker compose up --scale api=2` **fails** rather than silently starting two writers against
    one SQLite file. If `container_name` is ever removed, this obligation must be replaced by a real
    concurrency story, not deleted.
19. `nginx/nginx.conf` is mounted read-only; the container cannot modify it.
20. The 23 existing tests still pass. They talk to the app directly and must not acquire a
    dependency on the proxy.

## Verification

Run 2026-08-23 against a live stack. All 20 obligations pass.

| # | Obligation | Result |
|---|---|---|
| 1 | Five endpoints through the proxy | pass — 201 / 200 / 200 / 200 / 204 |
| 2 | `Location` stays relative and resolves | pass — `/tasks/{uuid}`, follows to 200 |
| 3 | api unreachable directly from the host | pass — `docker compose port api 8080` returns nothing; `make ps` shows `8080/tcp` for api against `0.0.0.0:8080->8080/tcp` for nginx |
| 4 | App 404 body passes through unchanged | pass — `{"error":"Not Found",...}`, not an nginx page |
| 5 | Validation 400 passes through | pass |
| 6 | App receives real `X-Forwarded-For` | pass — captured on the wire: `X-Forwarded-For: 203.0.113.9, 192.168.65.1` |
| 7 | `Host` reaches the app as the client sent it | pass — captured on the wire: `Host: localhost` |
| 8 | Backend restart does not strand nginx | pass — **api forced onto a new IP** (172.18.0.2 → 172.18.0.4); nginx served 200 within 3s, no reload |
| 9 | 502 is prompt while api is down | pass — 502 in **0.1s**, not a hung connection |
| 10 | `/nginx-health` survives a dead backend | pass — `{"status":"UP","service":"nginx"}` with api stopped; nginx stayed `healthy` |
| 11 | Nginx waits for api health | pass — compose log shows `api Waiting → Healthy → nginx Starting` |
| 12 | Both healthy after `make up` | pass |
| 13 | `PORT=9000 make up` | pass — 9000 serves, 8080 has nothing |
| 14 | `make down` keeps `./data` | pass — 2 tasks before, 2 after |
| 15 | Log targets | pass — `make logs` shows both; `logs-api` only api; `logs-nginx` shows access lines with `rt=`/`uct=`/`urt=` |
| 16 | `make nginx-reload` rejects a broken config | pass — `nginx -t` failed with `unknown directive`, make exited 1, the running config was untouched |
| 17 | `docker compose config -q` silent | pass |
| 18 | `--scale api=2` refused | pass — **exit 1**, still exactly one api container |
| 19 | `nginx.conf` mounted read-only | pass — `Read-only file system` on write attempt |
| 20 | The 23 tests still pass | pass — 23 tests, 0 failures; they talk to the app directly and gained no proxy dependency |

### How obligations 6, 7 and 8 were actually proven

Both were nearly waved through on weak evidence, so the method matters:

**Headers.** Reading `proxy_set_header` out of the config proves what nginx is *configured* to
send, not what the application *receives*. A throwaway container on the compose network captured
the raw upstream request instead, showing the exact bytes nginx transmits.

**The DNS trap.** The first attempt restarted `api`, which came back on the *same* IP — a cached
resolution would have worked identically, so the test proved nothing. The real test parks a filler
container on the freed address so the backend is forced onto a new one. Only then does a stale
cache actually break, and only then is recovery meaningful. **If this obligation is ever re-tested,
check that the IP genuinely changed** — otherwise it is a green light that means nothing.

## Implementation notes

**`nginx:alpine` ships a real `curl`.** The spec said to use busybox `wget` because "the nginx
Alpine image is busybox-based; there is no curl". That was wrong — `nginx:alpine` (1.31.4 /
Alpine 3.24) carries `/usr/bin/curl`, a genuine 329 KB binary, version 8.21.0. Both healthchecks in
`compose.yaml` now read the same way, which is one less thing to explain.

The lesson is the same one the previous spec recorded about the Temurin image: check what is in the
image, do not reason about it from the base distro.

**Everything else went in as written.** The variable-based `proxy_pass`, the resolver, the separate
`/nginx-health`, `depends_on: service_healthy`, and `container_name` as a scaling guard all behaved
as specified on the first run.

## Open questions

None. All four were answered by the owner on 2026-08-23:

| Was open | Decided |
|---|---|
| One backend, or real load balancing? | **One backend.** SQLite cannot take two writers; real LB starts with replacing the database and is a separate spec |
| Is `/nginx-health` public? | **Yes**, on 8080 — one curl then says which layer is down |
| Rate limit values | **`100r/s`, burst 200** — generous, but the mechanism is live and tested |
| Nginx logs to disk or stdout? | **stdout**, read with `make logs`. No rotation, no second bind mount |

Two implementation-time TODOs remain, both recorded inline above: pinning `nginx:alpine` by digest,
and confirming busybox `wget` handles the healthcheck. Neither is a decision — they are facts to
look up while writing the files.

Record new questions here as they come up rather than deciding them silently in code.
