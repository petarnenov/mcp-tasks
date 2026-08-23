plugins {
    id("io.micronaut.application")
}

dependencies {
    annotationProcessor("io.micronaut:micronaut-http-validation")
    annotationProcessor("io.micronaut.serde:micronaut-serde-processor")

    implementation("io.micronaut:micronaut-http-server-netty")
    implementation("io.micronaut:micronaut-http-client")
    implementation("io.micronaut.serde:micronaut-serde-jackson")
    // Provides /health for the Compose healthcheck.
    implementation("io.micronaut:micronaut-management")

    // The MCP server, wrapping the official MCP Java SDK. Version comes from the Micronaut 5.1.1
    // platform BOM (micronaut-mcp 2.0.0 / mcp-core 2.0.0).
    //
    // Deliberately NOT com.anthropic:anthropic-java. That is a client FOR the Anthropic API --
    // for programs that send prompts to Claude. This server sits on the other end of the arrow:
    // it is called BY a model and never calls one. Adding it would mean an unused dependency and
    // an API key this service has no way to use.
    implementation("io.micronaut.mcp:micronaut-mcp-server-java-sdk")

    runtimeOnly("ch.qos.logback:logback-classic")
    runtimeOnly("org.yaml:snakeyaml")
}

application {
    mainClass = "dev.petrov.tasks.mcp.Application"
}

micronaut {
    version(property("micronautVersion") as String)
    runtime("netty")
    testRuntime("junit5")
    processing {
        incremental(true)
        annotations("dev.petrov.tasks.mcp.*")
    }
}
