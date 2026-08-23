package dev.petrov.tasks.mcp;

import io.micronaut.context.ApplicationContext;
import io.micronaut.http.HttpRequest;
import io.micronaut.http.MediaType;
import io.micronaut.http.client.BlockingHttpClient;
import io.micronaut.http.client.HttpClient;
import io.micronaut.runtime.server.EmbeddedServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Obligations 1-8 of vault/specs/mcp-server.md, driven over real HTTP against a stubbed task API.
 *
 * <p>The MCP server and {@link StubTasksApi} share one context on a fixed port, so the declarative
 * client can be pointed at the same server that hosts the stub.
 */
class McpServerTest {

    private static final int PORT = 18877;

    static EmbeddedServer server;
    static BlockingHttpClient client;

    @BeforeAll
    static void startServer() {
        server = ApplicationContext.run(EmbeddedServer.class, Map.of(
                "micronaut.server.port", PORT,
                "stub.tasks.enabled", "true",
                "tasks.api.url", "http://localhost:" + PORT
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

    // ---------- helpers ----------

    private static Map<String, Object> rpc(String method, Object params) {
        return params == null
                ? Map.of("jsonrpc", "2.0", "id", 1, "method", method)
                : Map.of("jsonrpc", "2.0", "id", 1, "method", method, "params", params);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> send(Map<String, Object> body) {
        return client.retrieve(
                HttpRequest.POST("/mcp", body)
                        .accept(MediaType.APPLICATION_JSON, "text/event-stream"),
                Map.class);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> callTool(String name, Map<String, Object> arguments) {
        Map<String, Object> response =
                send(rpc("tools/call", Map.of("name", name, "arguments", arguments)));
        assertFalse(response.containsKey("error"),
                "tool failures belong in result.isError, not as a JSON-RPC protocol error: " + response);
        return (Map<String, Object>) response.get("result");
    }

    @SuppressWarnings("unchecked")
    private static String textOf(Map<String, Object> result) {
        List<Map<String, Object>> content = (List<Map<String, Object>>) result.get("content");
        return (String) content.get(0).get("text");
    }

    private static String createTask(String title) {
        Map<String, Object> result = callTool("tasks_create", Map.of("title", title));
        assertEquals(Boolean.FALSE, result.get("isError"), textOf(result));
        String json = textOf(result);
        return json.replaceAll("^\\{\"id\":\"([^\"]+)\".*$", "$1");
    }

    // ---------- tests ----------

    @Test
    @DisplayName("1: initialize identifies the server as 'tasks'")
    @SuppressWarnings("unchecked")
    void initializeIdentifiesTheServer() {
        Map<String, Object> response = send(rpc("initialize", Map.of(
                "protocolVersion", "2025-06-18",
                "capabilities", Map.of(),
                "clientInfo", Map.of("name", "junit", "version", "0"))));

        Map<String, Object> result = (Map<String, Object>) response.get("result");
        assertNotNull(result, "initialize returned no result: " + response);
        Map<String, Object> info = (Map<String, Object>) result.get("serverInfo");
        assertEquals("tasks", info.get("name"));
    }

    @Test
    @DisplayName("2: tools/list returns exactly the five tools, each described and schema'd")
    @SuppressWarnings("unchecked")
    void toolsAreRegistered() {
        Map<String, Object> result = (Map<String, Object>) send(rpc("tools/list", null)).get("result");
        List<Map<String, Object>> tools = (List<Map<String, Object>>) result.get("tools");

        assertEquals(
                List.of("tasks_create", "tasks_delete", "tasks_get", "tasks_list", "tasks_update"),
                tools.stream().map(t -> (String) t.get("name")).sorted().toList());

        for (Map<String, Object> tool : tools) {
            String name = (String) tool.get("name");
            assertNotNull(tool.get("inputSchema"), name + " has no input schema");
            String description = (String) tool.get("description");
            assertTrue(description != null && !description.isBlank(), name + " has no description");
        }
    }

    @Test
    @DisplayName("2: tasks_update's description warns that omitted fields are reset")
    @SuppressWarnings("unchecked")
    void updateDescriptionWarnsAboutReplaceSemantics() {
        Map<String, Object> result = (Map<String, Object>) send(rpc("tools/list", null)).get("result");
        List<Map<String, Object>> tools = (List<Map<String, Object>>) result.get("tools");

        String description = tools.stream()
                .filter(t -> "tasks_update".equals(t.get("name")))
                .map(t -> (String) t.get("description"))
                .findFirst()
                .orElseThrow();

        // A model that assumes patch semantics silently wipes fields. The description is the only
        // place it can learn otherwise, so this is load-bearing text, not documentation.
        assertTrue(description.toLowerCase().contains("full replace"), description);
        assertTrue(description.toLowerCase().contains("reset"), description);
    }

    @Test
    @DisplayName("3: create then get round-trips through the task API")
    void createThenGetRoundTrips() {
        String id = createTask("round trip");

        Map<String, Object> fetched = callTool("tasks_get", Map.of("id", id));
        assertEquals(Boolean.FALSE, fetched.get("isError"));
        assertTrue(textOf(fetched).contains("round trip"), textOf(fetched));
    }

    @Test
    @DisplayName("3: tasks_list returns what was created")
    void listReturnsCreatedTasks() {
        createTask("listed task");

        Map<String, Object> listed = callTool("tasks_list", Map.of());
        assertEquals(Boolean.FALSE, listed.get("isError"));
        assertTrue(textOf(listed).contains("listed task"));
    }

    @Test
    @DisplayName("5: tasks_update omitting priority resets it, matching the REST contract")
    void updateResetsOmittedFields() {
        Map<String, Object> created = callTool("tasks_create",
                Map.of("title", "high one", "priority", "HIGH"));
        assertTrue(textOf(created).contains("\"priority\":\"HIGH\""), textOf(created));
        String id = textOf(created).replaceAll("^\\{\"id\":\"([^\"]+)\".*$", "$1");

        Map<String, Object> updated =
                callTool("tasks_update", Map.of("id", id, "title", "only the title"));

        assertEquals(Boolean.FALSE, updated.get("isError"));
        assertTrue(textOf(updated).contains("\"priority\":\"MEDIUM\""),
                "omitted priority must reset, not persist: " + textOf(updated));
    }

    @Test
    @DisplayName("6: tasks_delete is idempotent and never reports an error")
    void deleteIsIdempotent() {
        String id = createTask("to delete");

        for (int attempt = 1; attempt <= 2; attempt++) {
            Map<String, Object> result = callTool("tasks_delete", Map.of("id", id));
            assertEquals(Boolean.FALSE, result.get("isError"), "attempt " + attempt);
        }
        Map<String, Object> unknown = callTool("tasks_delete", Map.of("id", "never-existed"));
        assertEquals(Boolean.FALSE, unknown.get("isError"));
    }

    @Test
    @DisplayName("7: tasks_get on an unknown id is a readable tool error, not a protocol error")
    void unknownIdIsAReadableToolError() {
        Map<String, Object> result = callTool("tasks_get", Map.of("id", "no-such-task"));

        assertEquals(Boolean.TRUE, result.get("isError"), textOf(result));
        String text = textOf(result);
        assertTrue(text.contains("no-such-task"), text);
        // The 404-becomes-null path in the declarative client used to make this a cheerful
        // success with a body of "null". Guard against that specifically.
        assertFalse("null".equals(text), "a missing task must not be reported as success");
    }

    @Test
    @DisplayName("8: a validation failure from the task API is a readable tool error")
    void validationFailureIsAReadableToolError() {
        Map<String, Object> result = callTool("tasks_create", Map.of("title", "   "));

        assertEquals(Boolean.TRUE, result.get("isError"), textOf(result));
        assertTrue(textOf(result).toLowerCase().contains("title"), textOf(result));
    }
}
