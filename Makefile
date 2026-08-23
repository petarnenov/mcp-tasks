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

IMAGE   ?= tasks
TAG     ?= latest
PORT    ?= 8080
COMPOSE ?= docker compose
GRADLE  := ./gradlew
DB      := data/tasks.db

.PHONY: help build test test-one run clean \
        docker-build up down restart logs shell ps \
        db-shell db-reset

# ---- Local -------------------------------------------------------------------

help:  ## Print this help
	@echo "Task API -- available targets:"
	@echo ""
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Overridable: IMAGE=$(IMAGE) TAG=$(TAG) PORT=$(PORT)"

build:  ## Compile, run the tests, and assemble the jar
	$(GRADLE) build

test:  ## Run the full test suite
	$(GRADLE) test

test-one:  ## Run one test class or method: make test-one TEST='*TimestampsTest*'
	@test -n "$(TEST)" || { echo "usage: make test-one TEST='*TimestampsTest*'"; exit 1; }
	$(GRADLE) test --tests '$(TEST)'

run:  ## Run the service on the host, no Docker (http://localhost:8080)
	$(GRADLE) run

clean:  ## Remove build output. Does NOT touch the database
	$(GRADLE) clean

# ---- Docker ------------------------------------------------------------------

docker-build:  ## Build the container image
	docker build -t $(IMAGE):$(TAG) .

up:  ## Start the service in Docker, building if needed
	$(COMPOSE) up --build -d
	@echo "-> http://localhost:$(PORT)/tasks   (make ps for health, make logs to follow)"

down:  ## Stop the service. Data in ./data survives
	$(COMPOSE) down

restart: down up  ## Stop then start

logs:  ## Follow the service logs
	$(COMPOSE) logs -f api

shell:  ## Open a shell inside the running container
	$(COMPOSE) exec api /bin/bash

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
