// Root project holds shared configuration only. The two services live in :task-api and
// :mcp-server; nothing is built from here.

plugins {
    id("io.micronaut.application") version "5.0.2" apply false
}

subprojects {
    apply(plugin = "java")

    group = "dev.petrov"
    version = "0.1.0"

    repositories {
        mavenCentral()
    }

    extensions.configure<JavaPluginExtension> {
        toolchain {
            // Micronaut 5 has a JDK 25 baseline, so this is forced by the framework rather than
            // chosen. The Gradle daemon must also run on 25 -- see gradle/gradle-daemon-jvm.properties.
            languageVersion = JavaLanguageVersion.of(25)
        }
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        testLogging {
            events("passed", "skipped", "failed")
        }
    }
}
