plugins {
    id("java")
    id("io.micronaut.application") version "4.6.2"
}

group = "dev.petrov"
version = "0.1.0"

repositories {
    mavenCentral()
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
    implementation("org.flywaydb:flyway-core")

    runtimeOnly("org.xerial:sqlite-jdbc:${property("sqliteJdbcVersion")}")
    runtimeOnly("ch.qos.logback:logback-classic")
    // Micronaut 4 does not bundle a YAML parser; application.yml is inert without it.
    runtimeOnly("org.yaml:snakeyaml")

    testImplementation("io.micronaut:micronaut-http-client")
}

application {
    mainClass = "dev.petrov.tasks.Application"
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
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

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
    }
}
