# syntax=docker/dockerfile:1

# Base images are pinned by digest, not by tag: a floating tag means this same Dockerfile
# produces a different image next month, which defeats half the point of containerizing.
# Security patches therefore need a deliberate edit — one that shows up in a diff.
#
#   eclipse-temurin:25-jdk  -> Temurin 25 LTS on Ubuntu 26.04  (resolved 2026-08-23)
#   eclipse-temurin:25-jre  -> Temurin 25.0.4 LTS on Ubuntu 26.04  (resolved 2026-08-23)
#
# Re-resolve with: docker buildx imagetools inspect eclipse-temurin:25-jre

# ---------- build ----------
FROM eclipse-temurin:25-jdk@sha256:e787e08ef76f4c16866108cd7f9fcd96a68eef3ac6cc76866897d4d02d5a2262 AS build

WORKDIR /src

# Build inputs first, sources second. An edit under src/ then reuses the cached dependency
# layer instead of re-downloading the Gradle distribution and the whole dependency graph.
COPY gradlew ./
COPY gradle ./gradle
COPY settings.gradle.kts build.gradle.kts gradle.properties ./
COPY task-api/build.gradle.kts task-api/
COPY mcp-server/build.gradle.kts mcp-server/
RUN ./gradlew --no-daemon :mcp-server:dependencies --quiet > /dev/null

COPY mcp-server/src mcp-server/src
# Tests are a gate (`make test`), not a packaging step. Running them here would double the
# image build time and fail the build for reasons unrelated to packaging.
RUN ./gradlew --no-daemon :mcp-server:build -x test

# ---------- runtime ----------
FROM eclipse-temurin:25-jre@sha256:f9e65324a37f28209ce7dd0e5149a7aa954520ed936fb87813cf6ded2400a112 AS runtime

# The Java 25 JRE image ships NO curl, wget or nc -- unlike the Java 21 one, which had curl and
# wget. The compose healthcheck probes /health over HTTP, so without this the container never
# reports healthy. A TCP-only probe was rejected: a JVM with an open socket and a broken
# datasource would pass it, which is exactly what /health exists to catch.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# A fixed UID, so the bind-mount ownership behaviour is predictable rather than dependent on
# whatever the base image's user table happens to contain.
RUN useradd --system --uid 10001 --create-home app

WORKDIR /app

# Micronaut's layered layout, not a fat jar. Neither tasks-<version>.jar nor
# tasks-<version>-runner.jar is self-contained: the runner jar's manifest carries a
# Class-Path pointing at sibling resources/ and libs/ directories, so copying it alone
# produces NoClassDefFoundError at startup. `./gradlew build` writes the matching layout
# under build/docker/main/layers via the buildLayers task.
#
# Copied dependencies-first so that a source-only change rebuilds one small layer instead
# of the 62-jar dependency layer.
COPY --from=build /src/mcp-server/build/docker/main/layers/libs      /app/libs
COPY --from=build /src/mcp-server/build/docker/main/layers/resources /app/resources
COPY --from=build /src/mcp-server/build/docker/main/layers/app/application.jar /app/application.jar

# This server holds no state of its own -- everything lives behind the task API. That is what
# lets it be scaled horizontally, unlike the api container.
ENV TASKS_API_URL=http://api:8080

USER 10001
EXPOSE 8877

ENTRYPOINT ["java", "-jar", "/app/application.jar"]
