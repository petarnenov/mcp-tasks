package dev.petrov.tasks;

import dev.petrov.tasks.dto.TaskResponse;
import io.micronaut.context.ApplicationContext;
import io.micronaut.http.HttpRequest;
import io.micronaut.http.HttpResponse;
import io.micronaut.http.HttpStatus;
import io.micronaut.http.MediaType;
import io.micronaut.http.client.BlockingHttpClient;
import io.micronaut.http.client.HttpClient;
import io.micronaut.http.client.exceptions.HttpClientResponseException;
import io.micronaut.runtime.server.EmbeddedServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * One test per numbered correctness obligation in vault/specs/task-api.md.
 *
 * <p>Runs against a real SQLite file in a temp directory, not an in-memory substitute: several of
 * the obligations are about SQLite and Flyway specifically, and a different engine would not
 * prove them.
 */
class TaskControllerTest {

    @TempDir
    static Path tempDir;

    static EmbeddedServer server;
    static BlockingHttpClient client;

    @BeforeAll
    static void startServer() {
        server = ApplicationContext.run(EmbeddedServer.class, Map.of(
                "datasources.default.url", "jdbc:sqlite:" + tempDir.resolve("controller-test.db"),
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

    @BeforeEach
    void emptyTheTable() {
        server.getApplicationContext().getBean(TaskRepository.class).deleteAll();
    }

    // ---------- helpers ----------

    private static Map<String, Object> body(String title, String description, String status, String priority) {
        Map<String, Object> map = new HashMap<>();
        map.put("title", title);
        map.put("description", description);
        map.put("status", status);
        map.put("priority", priority);
        map.values().removeIf(java.util.Objects::isNull);
        return map;
    }

    private static TaskResponse create(Map<String, Object> payload) {
        return client.retrieve(HttpRequest.POST("/tasks", payload), TaskResponse.class);
    }

    private static TaskResponse createTask(String title) {
        return create(body(title, null, null, null));
    }

    private static HttpStatus statusOf(Runnable call) {
        HttpClientResponseException thrown = assertThrows(HttpClientResponseException.class, call::run);
        return thrown.getStatus();
    }

    // ---------- Validation ----------

    @Test
    @DisplayName("1: POST with missing, empty or blank title -> 400, nothing written")
    void blankTitleRejected() {
        for (String title : new String[]{null, "", "   "}) {
            Map<String, Object> payload = body(title, null, null, null);
            assertEquals(HttpStatus.BAD_REQUEST, statusOf(() -> create(payload)), "title=" + title);
        }
        assertEquals(List.of(), listAll());
    }

    @Test
    @DisplayName("2: status outside the enum -> 400, not a coercion and not a 500")
    void invalidStatusRejected() {
        assertEquals(HttpStatus.BAD_REQUEST,
                statusOf(() -> create(body("t", null, "NOPE", null))));

        TaskResponse task = createTask("t");
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(() ->
                client.exchange(HttpRequest.PUT("/tasks/" + task.id(), body("t", null, "NOPE", null)))));
    }

    @Test
    @DisplayName("3: priority outside the enum -> 400")
    void invalidPriorityRejected() {
        assertEquals(HttpStatus.BAD_REQUEST,
                statusOf(() -> create(body("t", null, null, "URGENT"))));

        TaskResponse task = createTask("t");
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(() ->
                client.exchange(HttpRequest.PUT("/tasks/" + task.id(), body("t", null, null, "URGENT")))));
    }

    @Test
    @DisplayName("4: oversized title or description -> 400")
    void oversizedFieldsRejected() {
        assertEquals(HttpStatus.BAD_REQUEST,
                statusOf(() -> create(body("x".repeat(201), null, null, null))));
        assertEquals(HttpStatus.BAD_REQUEST,
                statusOf(() -> create(body("ok", "y".repeat(2001), null, null))));

        // The boundary itself is valid.
        assertNotNull(create(body("x".repeat(200), "y".repeat(2000), null, null)).id());
    }

    @Test
    @DisplayName("5: malformed JSON -> 400 with no stack trace in the body")
    void malformedJsonRejected() {
        HttpClientResponseException thrown = assertThrows(HttpClientResponseException.class, () ->
                client.exchange(HttpRequest.POST("/tasks", "{\"title\": ")
                        .contentType(MediaType.APPLICATION_JSON)));

        assertEquals(HttpStatus.BAD_REQUEST, thrown.getStatus());
        String responseBody = thrown.getResponse().getBody(String.class).orElse("");
        assertTrue(!responseBody.contains("at dev.petrov") && !responseBody.contains("Exception:"),
                "error body leaked a stack trace: " + responseBody);
    }

    // ---------- Identity ----------

    @Test
    @DisplayName("6: a client-supplied id in POST is ignored")
    void clientSuppliedIdIgnored() {
        Map<String, Object> payload = body("t", null, null, null);
        payload.put("id", "client-chosen-id");

        TaskResponse created = create(payload);
        assertNotEquals("client-chosen-id", created.id());
        assertEquals(HttpStatus.NOT_FOUND, statusOf(() -> get("client-chosen-id")));
    }

    @Test
    @DisplayName("7: PUT cannot change id or createdAt")
    void putCannotChangeIdOrCreatedAt() {
        TaskResponse created = createTask("original");

        Map<String, Object> payload = body("edited", null, null, null);
        payload.put("id", "hijacked");
        payload.put("createdAt", "1999-01-01T00:00:00.000000Z");

        TaskResponse updated = client.retrieve(
                HttpRequest.PUT("/tasks/" + created.id(), payload), TaskResponse.class);

        assertEquals(created.id(), updated.id());
        assertEquals(created.createdAt(), updated.createdAt());
        assertEquals("edited", updated.title());
    }

    // ---------- Not found ----------

    @Test
    @DisplayName("8: GET and PUT on an unknown id -> 404 with a JSON body")
    void unknownIdIsNotFound() {
        String unknown = java.util.UUID.randomUUID().toString();

        HttpClientResponseException thrown = assertThrows(HttpClientResponseException.class,
                () -> get(unknown));
        assertEquals(HttpStatus.NOT_FOUND, thrown.getStatus());
        assertTrue(thrown.getResponse().getBody(String.class).orElse("").contains("\"error\""),
                "404 should carry a JSON error body");

        assertEquals(HttpStatus.NOT_FOUND, statusOf(() ->
                client.exchange(HttpRequest.PUT("/tasks/" + unknown, body("t", null, null, null)))));
    }

    @Test
    @DisplayName("9: GET and PUT with a malformed id -> 404, not 500")
    void malformedIdIsNotFound() {
        assertEquals(HttpStatus.NOT_FOUND, statusOf(() -> get("not-a-uuid")));
        assertEquals(HttpStatus.NOT_FOUND, statusOf(() ->
                client.exchange(HttpRequest.PUT("/tasks/not-a-uuid", body("t", null, null, null)))));
    }

    // ---------- Semantics ----------

    @Test
    @DisplayName("10: POST -> 201 with a Location header that resolves")
    void createReturnsResolvableLocation() {
        HttpResponse<TaskResponse> response = client.exchange(
                HttpRequest.POST("/tasks", body("t", null, null, null)), TaskResponse.class);

        assertEquals(HttpStatus.CREATED, response.getStatus());
        String location = response.getHeaders().get("Location");
        assertNotNull(location, "Location header missing");

        TaskResponse fetched = client.retrieve(HttpRequest.GET(location), TaskResponse.class);
        assertEquals(response.body().id(), fetched.id());
    }

    @Test
    @DisplayName("11: GET /tasks on an empty database -> 200 with []")
    void emptyListIsEmptyArray() {
        HttpResponse<String> response = client.exchange(HttpRequest.GET("/tasks"), String.class);
        assertEquals(HttpStatus.OK, response.getStatus());
        assertEquals("[]", response.body());
    }

    @Test
    @DisplayName("12: POST defaults status to TODO and priority to MEDIUM")
    void createAppliesDefaults() {
        TaskResponse created = createTask("t");
        assertEquals("TODO", created.status().name());
        assertEquals("MEDIUM", created.priority().name());
    }

    @Test
    @DisplayName("13: PUT clears description when the field is omitted")
    void putClearsOmittedDescription() {
        TaskResponse created = create(body("t", "some notes", null, null));
        assertEquals("some notes", created.description());

        TaskResponse updated = client.retrieve(
                HttpRequest.PUT("/tasks/" + created.id(), body("t", null, null, null)),
                TaskResponse.class);

        assertNull(updated.description(), "PUT is a full replace: an omitted description clears it");
    }

    @Test
    @DisplayName("14: PUT resets omitted priority and status to their defaults")
    void putResetsOmittedEnums() {
        TaskResponse created = create(body("t", null, "IN_PROGRESS", "HIGH"));
        assertEquals("IN_PROGRESS", created.status().name());
        assertEquals("HIGH", created.priority().name());

        TaskResponse updated = client.retrieve(
                HttpRequest.PUT("/tasks/" + created.id(), body("only the title", null, null, null)),
                TaskResponse.class);

        assertEquals("MEDIUM", updated.priority().name(), "omitted priority must reset, not persist");
        assertEquals("TODO", updated.status().name(), "omitted status must reset, not persist");
    }

    @Test
    @DisplayName("15: updatedAt strictly advances on PUT, createdAt is untouched")
    void updatedAtAdvances() {
        TaskResponse created = createTask("t");
        assertEquals(created.createdAt(), created.updatedAt(), "a fresh task has equal timestamps");

        String previous = created.updatedAt();
        for (int i = 0; i < 5; i++) {
            TaskResponse updated = client.retrieve(
                    HttpRequest.PUT("/tasks/" + created.id(), body("edit " + i, null, null, null)),
                    TaskResponse.class);

            assertEquals(created.createdAt(), updated.createdAt(), "createdAt must not move");
            assertTrue(Instant.parse(updated.updatedAt()).isAfter(Instant.parse(previous)),
                    "updatedAt did not advance: " + previous + " -> " + updated.updatedAt());
            assertTrue(updated.updatedAt().compareTo(previous) > 0,
                    "fixed-width timestamps must also sort lexicographically");
            previous = updated.updatedAt();
        }
    }

    @Test
    @DisplayName("16: DELETE is idempotent - 204 for existing, already-deleted and never-existing ids")
    void deleteIsIdempotent() {
        TaskResponse created = createTask("t");

        assertEquals(HttpStatus.NO_CONTENT, delete("/tasks/" + created.id()));
        assertEquals(HttpStatus.NOT_FOUND, statusOf(() -> get(created.id())));

        assertEquals(HttpStatus.NO_CONTENT, delete("/tasks/" + created.id()),
                "a repeated DELETE must stay 204");
        assertEquals(HttpStatus.NO_CONTENT, delete("/tasks/" + java.util.UUID.randomUUID()),
                "deleting an id that never existed must be 204");
        assertEquals(HttpStatus.NO_CONTENT, delete("/tasks/not-a-uuid"),
                "deleting a malformed id must be 204");
    }

    // ---------- small wrappers ----------

    private static TaskResponse get(String id) {
        return client.retrieve(HttpRequest.GET("/tasks/" + id), TaskResponse.class);
    }

    private static HttpStatus delete(String uri) {
        return client.exchange(HttpRequest.DELETE(uri)).getStatus();
    }

    private static List<TaskResponse> listAll() {
        return client.retrieve(HttpRequest.GET("/tasks"),
                io.micronaut.core.type.Argument.listOf(TaskResponse.class));
    }
}
