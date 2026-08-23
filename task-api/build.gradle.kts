plugins {
    id("io.micronaut.application")
}

dependencies {
    annotationProcessor("io.micronaut:micronaut-http-validation")
    annotationProcessor("io.micronaut.serde:micronaut-serde-processor")
    annotationProcessor("io.micronaut.data:micronaut-data-processor")
    annotationProcessor("io.micronaut.validation:micronaut-validation-processor")

    implementation("io.micronaut:micronaut-http-server-netty")
    implementation("io.micronaut.serde:micronaut-serde-jackson")
    implementation("io.micronaut.validation:micronaut-validation")
    implementation("io.micronaut.data:micronaut-data-jdbc")
    implementation("io.micronaut.sql:micronaut-jdbc-hikari")
    implementation("io.micronaut.flyway:micronaut-flyway")
    // Provides /health, which the Compose healthcheck probes.
    implementation("io.micronaut:micronaut-management")
    implementation("org.flywaydb:flyway-core")

    runtimeOnly("org.xerial:sqlite-jdbc:${property("sqliteJdbcVersion")}")
    runtimeOnly("ch.qos.logback:logback-classic")
    // Still required on Micronaut 5 (re-checked 2026-08-23 by removing it: the build fails with
    // "YAML configuration file detected but snakeyaml is not on classpath"). No YAML parser is
    // bundled, so application.yml is inert without this.
    runtimeOnly("org.yaml:snakeyaml")

    testImplementation("io.micronaut:micronaut-http-client")
}

application {
    mainClass = "dev.petrov.tasks.Application"
}

// The datasource URL is relative (`jdbc:sqlite:data/tasks.db`) so that the local run and the
// container's bind mount share one file. Gradle runs a subproject from ITS OWN directory, which
// would put the database at task-api/data/ and fail with SQLITE_CANTOPEN on a fresh checkout.
// Pin the working directory to the repo root so `make run` behaves the way it documents.
tasks.named<JavaExec>("run") {
    workingDir = rootProject.projectDir
}

micronaut {
    version(property("micronautVersion") as String)
    runtime("netty")
    testRuntime("junit5")
    processing {
        incremental(true)
        annotations("dev.petrov.tasks.*")
    }
}
