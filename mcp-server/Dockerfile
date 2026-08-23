# syntax=docker/dockerfile:1

# Base image pinned by digest, not by tag: a floating tag means this same Dockerfile produces a
# different image next month, which defeats half the point of containerizing. Security patches
# therefore need a deliberate edit — one that shows up in a diff.
#
#   node:24-alpine -> Node 24.19.0 LTS, npm 11.17.0, Alpine 3.24.1  (resolved 2026-08-23)
#
# Re-resolve with: docker buildx imagetools inspect node:24-alpine

# ---------- build ----------
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build

WORKDIR /src

# Manifest and lockfile first, sources second. An edit under src/ then reuses the cached install
# layer instead of re-resolving the whole dependency tree.
#
# `npm ci`, not `npm install`: it installs exactly what package-lock.json pins and fails if the
# lockfile and the manifest disagree, so the image cannot quietly drift from what was tested.
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci

COPY mcp-server/tsconfig.json ./
COPY mcp-server/src ./src
# Tests are a gate (`make test`), not a packaging step. Running them here would fail the build
# for reasons unrelated to packaging.
RUN npm run build

# Drop dev dependencies (typescript, vitest, the client SDK) from what gets copied forward.
# `--omit=dev` on top of the existing tree prunes in place rather than reinstalling.
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime

# No curl, and none is installed: unlike the JRE images the api uses, this one ships a runtime
# that can make an HTTP request by itself. The compose healthcheck calls `node -e fetch(...)`,
# which is a real HTTP probe against /health with no extra package in the image.

# The node image already ships a non-root `node` user (uid 1000). Reusing it rather than adding
# another keeps the ownership story to one uid.
WORKDIR /app

COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/dist ./dist
COPY --from=build --chown=node:node /src/package.json ./package.json

# This server holds no state of its own — everything lives behind the task API. That is what lets
# it be scaled horizontally, unlike the api container.
ENV TASKS_API_URL=http://api:8080
ENV NODE_ENV=production

USER node
EXPOSE 8877

# `node dist/index.js`, not `npm start`: npm would sit between the container and the process as a
# PID 1 that does not forward SIGTERM, so `make down` would hit the 10s kill timeout every time.
ENTRYPOINT ["node", "dist/index.js"]
