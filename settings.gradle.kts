plugins {
    // Lets Gradle download a matching JDK when the machine does not already have one, so a
    // fresh clone builds without anyone installing Java 25 by hand. Also what makes
    // `updateDaemonJvm` able to record the daemon toolchain.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "tasks"

// One Gradle module. The MCP server is a Node/TypeScript project under mcp-server/ and is built
// by npm, not Gradle -- see vault/specs/mcp-server-typescript.md. `make build` runs both.
include("task-api")
