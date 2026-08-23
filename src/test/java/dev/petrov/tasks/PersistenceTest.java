package dev.petrov.tasks;

import dev.petrov.tasks.dto.CreateTaskRequest;
import io.micronaut.context.ApplicationContext;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Obligations 17-19: the SQLite file is the real store and Flyway behaves across restarts.
 *
 * <p>These deliberately start and stop whole application contexts rather than making two calls
 * inside one. A single context would pass even if the data never left memory, which is exactly
 * the failure being guarded against.
 */
class PersistenceTest {

    @TempDir
    Path tempDir;

    private Map<String, Object> configFor(Path database) {
        return Map.of("datasources.default.url", "jdbc:sqlite:" + database);
    }

    @Test
    @DisplayName("17+19: data written before a restart is readable after it")
    void dataSurvivesRestart() {
        Path database = tempDir.resolve("restart.db");
        assertFalse(Files.exists(database), "precondition: the database file does not exist yet");

        String id;
        try (ApplicationContext first = ApplicationContext.run(configFor(database))) {
            id = first.getBean(TaskService.class)
                    .create(new CreateTaskRequest("survivor", "written before restart", null, null))
                    .id();
        }

        assertTrue(Files.exists(database), "the SQLite file must exist on disk after the first run");

        try (ApplicationContext second = ApplicationContext.run(configFor(database))) {
            var reopened = second.getBean(TaskService.class).get(id);
            assertEquals("survivor", reopened.title());
            assertEquals("written before restart", reopened.description());
            assertEquals(1, second.getBean(TaskService.class).list().size(),
                    "a second startup must not wipe existing rows");
        }
    }

    @Test
    @DisplayName("18+19: Flyway creates the schema once and does not re-run it")
    void flywayMigratesOnceOnly() throws Exception {
        Path database = tempDir.resolve("flyway.db");

        try (ApplicationContext first = ApplicationContext.run(configFor(database))) {
            first.getBean(TaskService.class).list();
        }
        assertEquals(1, appliedMigrations(database), "V1 should be applied on a first run");

        try (ApplicationContext second = ApplicationContext.run(configFor(database))) {
            second.getBean(TaskService.class).list();
        }
        assertEquals(1, appliedMigrations(database), "V1 must not be applied a second time");
    }

    /**
     * Reads the file directly rather than through the injected DataSource: the application's
     * DataSource is a Micronaut Data contextual proxy that demands an open transaction, and going
     * around it also proves the history really is in the file on disk.
     */
    private int appliedMigrations(Path database) throws Exception {
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + database);
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT COUNT(*) FROM flyway_schema_history WHERE version = '1'")) {
            rows.next();
            return rows.getInt(1);
        }
    }
}
