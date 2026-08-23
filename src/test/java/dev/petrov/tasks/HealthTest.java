package dev.petrov.tasks;

import io.micronaut.context.ApplicationContext;
import io.micronaut.http.HttpRequest;
import io.micronaut.http.HttpResponse;
import io.micronaut.http.HttpStatus;
import io.micronaut.http.client.BlockingHttpClient;
import io.micronaut.http.client.HttpClient;
import io.micronaut.runtime.server.EmbeddedServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Obligation 17 of vault/specs/docker-and-make.md.
 *
 * <p>The Compose healthcheck probes this endpoint. If it stops responding the container is
 * reported unhealthy, so this is load-bearing rather than decorative.
 */
class HealthTest {

    @TempDir
    static Path tempDir;

    static EmbeddedServer server;
    static BlockingHttpClient client;

    @BeforeAll
    static void startServer() {
        server = ApplicationContext.run(EmbeddedServer.class, Map.of(
                "datasources.default.url", "jdbc:sqlite:" + tempDir.resolve("health-test.db"),
                "micronaut.server.port", -1
        ));
        client = server.getApplicationContext()
                .createBean(HttpClient.class, server.getURL())
                .toBlocking();
    }

    @AfterAll
    static void stopServer() {
        if (client != null) {
            client.close();
        }
        if (server != null) {
            server.close();
        }
    }

    @Test
    @DisplayName("17: GET /health returns 200 with status UP")
    void healthIsUp() {
        HttpResponse<String> response = client.exchange(HttpRequest.GET("/health"), String.class);

        assertEquals(HttpStatus.OK, response.getStatus());
        String body = response.body();
        assertTrue(body != null && body.contains("\"UP\""),
                "expected an UP status in the health body, got: " + body);
    }
}
