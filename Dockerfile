# syntax=docker/dockerfile:1

# Base images are pinned by digest, not by tag: a floating tag means this same Dockerfile
# produces a different image next month, which defeats half the point of containerizing.
# Security patches therefore need a deliberate edit — one that shows up in a diff.
#
#   eclipse-temurin:21-jdk  -> Temurin 21.0.12 LTS on Ubuntu 26.04  (resolved 2026-08-23)
#   eclipse-temurin:21-jre  -> Temurin 21.0.12 LTS on Ubuntu 26.04  (resolved 2026-08-23)
#
# Re-resolve with: docker buildx imagetools inspect eclipse-temurin:21-jre

# ---------- build ----------
FROM eclipse-temurin:21-jdk@sha256:85f00967bcc624fc19fa9c2cf124ea426a5363898e267141726f31f358c2e14b AS build

WORKDIR /src

# Build inputs first, sources second. An edit under src/ then reuses the cached dependency
# layer instead of re-downloading the Gradle distribution and the whole dependency graph.
COPY gradlew ./
COPY gradle ./gradle
COPY settings.gradle.kts build.gradle.kts gradle.properties ./
RUN ./gradlew --no-daemon dependencies --quiet > /dev/null

COPY src ./src
# Tests are a gate (`make test`), not a packaging step. Running them here would double the
# image build time and fail the build for reasons unrelated to packaging.
RUN ./gradlew --no-daemon build -x test

# ---------- runtime ----------
FROM eclipse-temurin:21-jre@sha256:7a65df4b22d2de92d4e04056e884f3b9122d70b21e2847fd66084278bd0ce037 AS runtime

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
COPY --from=build /src/build/docker/main/layers/libs      /app/libs
COPY --from=build /src/build/docker/main/layers/resources /app/resources
COPY --from=build /src/build/docker/main/layers/app/application.jar /app/application.jar

# The database lives on a mounted volume, never in the container's writable layer.
ENV DATASOURCES_DEFAULT_URL=jdbc:sqlite:/data/tasks.db

USER 10001
EXPOSE 8080

ENTRYPOINT ["java", "-jar", "/app/application.jar"]
