# Single entry point for every operation in this repo. Run `make` for the list.
#
# Targets GNU Make 3.81, which is what macOS ships. That rules out .ONESHELL (3.82+), so every
# recipe line runs in its own shell -- chain with && rather than relying on state across lines.
#
# Strictness note: .SHELLFLAGS is SILENTLY IGNORED by 3.81 (verified), so the -e and -o pipefail
# flags are set on SHELL itself. That form works on both 3.81 and 4.x. Do not "modernize" this
# into .SHELLFLAGS -- on macOS it would look strict while quietly letting failed pipes pass.
SHELL := /bin/bash -o pipefail -e

.DEFAULT_GOAL := help

IMAGE     ?= tasks
MCP_IMAGE ?= tasks-mcp
TAG     ?= latest
PORT     ?= 8080
MCP_PORT ?= 8877
# Three by default: with one replica a broken balancer or an accidentally stateful server
# looks exactly like a working one. The default path should be the one that gets tested.
REPLICAS ?= 3
COMPOSE ?= docker compose
GRADLE  := ./gradlew
# The MCP server is a Node/TypeScript project, not a Gradle module. `--prefix` keeps every recipe
# runnable from the repository root without a cd that the next line would forget.
NPM     := npm --prefix mcp-server
NPM_CLIENT := npm --prefix mcp-client
# Pinned so `make run-mcp-inspector` cannot silently change tool underneath you. Bump it
# deliberately; `npx -y` would otherwise fetch whatever is newest that day.
INSPECTOR ?= @modelcontextprotocol/inspector@2.3.0
DB      := data/tasks.db

.PHONY: help build build-api build-mcp build-client test test-api test-mcp test-client test-one \
        run clean install install-client run-mcp run-mcp-inspector run-client docker-build up down \
        restart scale logs logs-api logs-mcp logs-nginx ps shell nginx-reload db-shell db-reset

# ---- Local -------------------------------------------------------------------

help:  ## Print this help
	@echo "Task API -- available targets:"
	@echo ""
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Overridable: IMAGE=$(IMAGE) MCP_IMAGE=$(MCP_IMAGE) TAG=$(TAG) PORT=$(PORT) MCP_PORT=$(MCP_PORT) REPLICAS=$(REPLICAS)"

build: build-api build-mcp build-client  ## Build and test everything

build-api:  ## Compile, run the tests, and assemble the task API jar
	$(GRADLE) build

build-mcp: install  ## Typecheck, test and compile the MCP server to mcp-server/dist
	$(NPM) run build
	$(NPM) test

build-client: install-client  ## Typecheck, test and bundle the browser MCP client
	$(NPM_CLIENT) run build
	$(NPM_CLIENT) test

install:  ## Install the MCP server's dependencies from the lockfile
	$(NPM) ci

install-client:  ## Install the MCP client's dependencies from the lockfile
	$(NPM_CLIENT) ci

test: test-api test-mcp test-client  ## Run every test suite

test-api:  ## Run the task API tests (JUnit)
	$(GRADLE) test

test-mcp: install  ## Run the MCP server tests (vitest)
	$(NPM) test

test-client: install-client  ## Run the MCP client tests (vitest)
	$(NPM_CLIENT) test

test-one:  ## Run one API test class or method: make test-one TEST='*TimestampsTest*'
	@test -n "$(TEST)" || { echo "usage: make test-one TEST='*TimestampsTest*'"; exit 1; }
	$(GRADLE) test --tests '$(TEST)'

run:  ## Run the task API on the host, no Docker (http://localhost:8080)
	$(GRADLE) :task-api:run

# Compiles first (the `dev` script is `tsc && node dist/index.js`). Node strips TypeScript types
# but does not resolve a `.js` import specifier to the `.ts` file beside it, so running the
# sources directly fails on the first relative import.
run-mcp: install  ## Run the MCP server on the host, no Docker (needs `make run` in another shell)
	TASKS_API_URL=$${TASKS_API_URL:-http://localhost:8080} $(NPM) run dev

# Runs the tool, not the server -- the MCP server must already be up (`make up` or `make run-mcp`).
# Needs network on first run: npx downloads the inspector.
#
# Two things to know once it opens, both its defaults rather than ours:
#   - Transport is Streamable HTTP; the URL is printed below.
#   - Protocol Era defaults to "Legacy (2025-11-25 handshake)" -- its own docstring says debugging
#     tools should not auto-probe. Switch it to Modern or Auto in the server's Settings, or the
#     connection shows LEGACY even though this server serves 2026-07-28.
run-mcp-inspector:  ## Open the MCP Inspector against the running MCP server
	@echo "MCP endpoint: http://localhost:$(MCP_PORT)/mcp   (also http://localhost:$(PORT)/mcp)"
	@echo "In the Inspector, set Protocol Era to Modern or Auto to negotiate 2026-07-28."
	npx -y $(INSPECTOR)

# Serves from the nginx bind mount, so `make up` must be running. Unlike the Inspector this needs
# no Protocol Era setting: the client is pinned to 2026-07-28 in code.
run-client:  ## Open the browser MCP client (needs `make up`)
	@echo "Opening http://localhost:$(PORT)/mcp/client"
	@open "http://localhost:$(PORT)/mcp/client" 2>/dev/null \
	  || echo "Could not open a browser; go to http://localhost:$(PORT)/mcp/client"



clean:  ## Remove build output. Does NOT touch the database or node_modules
	$(GRADLE) clean
	rm -rf mcp-server/dist mcp-client/dist

# ---- Docker ------------------------------------------------------------------

docker-build:  ## Build both container images
	docker build -f task-api/Dockerfile -t $(IMAGE):$(TAG) .
	docker build -f mcp-server/Dockerfile -t $(MCP_IMAGE):$(TAG) .

# Depends on build-client because the page is a BIND MOUNT, not a layer in the nginx image:
# without mcp-client/dist the mount point is missing and /mcp/client 404s on a stack that
# otherwise looks healthy.
up: build-client  ## Start everything in Docker, building if needed
	$(COMPOSE) up --build -d --scale mcp=$(REPLICAS)
	@echo "-> REST:   http://localhost:$(PORT)/tasks"
	@echo "-> MCP:    http://localhost:$(MCP_PORT)/mcp   (also http://localhost:$(PORT)/mcp)"
	@echo "-> Client: http://localhost:$(PORT)/mcp/client"
	@echo "   $(REPLICAS) MCP replica(s). make ps for health, make scale REPLICAS=n to change."

down:  ## Stop the service. Data in ./data survives
	$(COMPOSE) down

restart: down up  ## Stop then start

logs:  ## Follow logs from all services
	$(COMPOSE) logs -f

logs-api:  ## Follow the application logs only
	$(COMPOSE) logs -f api

scale:  ## Set the MCP replica count: make scale REPLICAS=5
	$(COMPOSE) up -d --no-recreate --scale mcp=$(REPLICAS)
	@echo "mcp scaled to $(REPLICAS)"

logs-mcp:  ## Follow the MCP server logs only
	$(COMPOSE) logs -f mcp

logs-nginx:  ## Follow the nginx access and error logs only
	$(COMPOSE) logs -f nginx

shell:  ## Open a shell inside the running api container
	$(COMPOSE) exec api /bin/bash

nginx-reload:  ## Validate nginx.conf and reload it without restarting anything
	$(COMPOSE) exec nginx nginx -t
	$(COMPOSE) exec nginx nginx -s reload
	@echo "nginx reloaded"

ps:  ## Show container status and health
	$(COMPOSE) ps

# ---- Database ----------------------------------------------------------------

db-shell:  ## Open sqlite3 against the database
	@test -f $(DB) || { echo "no database at $(DB) -- start the service first"; exit 1; }
	sqlite3 $(DB)

db-reset:  ## DELETE the database. Destructive, asks first
	@printf 'Delete %s and all tasks in it? [y/N] ' '$(DB)'
	@read ans && [ "$$ans" = "y" ] || { echo "aborted"; exit 1; }
	rm -f $(DB) $(DB)-shm $(DB)-wal
	@echo "deleted $(DB)"
