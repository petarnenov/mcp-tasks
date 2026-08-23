package dev.petrov.tasks.mcp;

import io.micronaut.core.annotation.Nullable;
import io.micronaut.http.client.exceptions.HttpClientResponseException;
import io.micronaut.mcp.annotations.Tool;
import io.micronaut.mcp.annotations.ToolArg;
import io.micronaut.serde.ObjectMapper;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import jakarta.inject.Singleton;

/**
 * The task API exposed as MCP tools.
 *
 * <p>Names are prefixed with {@code tasks_} so they cannot collide when a client is connected to
 * several servers at once. Some clients namespace by server name themselves, in which case these
 * appear doubly prefixed; that was accepted in exchange for names that stand alone.
 *
 * <p>Every tool returns a {@link CallToolResult} rather than throwing. A failure is reported with
 * {@code isError = true} and a readable message, which is what MCP asks for: JSON-RPC protocol
 * errors are for malformed requests, while a tool that ran and could not do the job should hand
 * the model something it can read and act on. Throwing was tried first and the SDK swallowed the
 * message, turning every failure into an opaque {@code -32603}.
 *
 * <p>This class holds no state. That is what allows the service to be scaled horizontally, unlike
 * the task API behind it, which owns a SQLite file and must stay single-writer.
 */
@Singleton
public class TaskTools {

    private final TasksClient tasks;
    private final ObjectMapper json;

    public TaskTools(TasksClient tasks, ObjectMapper json) {
        this.tasks = tasks;
        this.json = json;
    }

    @Tool(name = "tasks_list", description = "List every task, with its status and priority.")
    public CallToolResult list() {
        try {
            return ok(tasks.list());
        } catch (HttpClientResponseException e) {
            return apiError(e);
        }
    }

    @Tool(name = "tasks_get", description = "Fetch a single task by its id.")
    public CallToolResult get(
            @ToolArg(description = "The task's UUID, as returned by tasks_list") String id) {
        try {
            // Micronaut's declarative client maps a 404 to null for a POJO return type rather
            // than throwing, so the null check IS the not-found path. Without it the tool
            // cheerfully reports success with a body of "null".
            TaskDtos.TaskResponse task = tasks.get(id);
            return task == null ? notFound(id) : ok(task);
        } catch (HttpClientResponseException e) {
            if (e.getStatus().getCode() == 404) {
                return notFound(id);
            }
            return apiError(e);
        }
    }

    @Tool(name = "tasks_create", description = "Create a new task and return it.")
    public CallToolResult create(
            @ToolArg(description = "Short title. Required, max 200 characters") String title,
            @ToolArg(description = "Optional longer description, max 2000 characters")
            @Nullable String description,
            @ToolArg(description = "One of TODO, IN_PROGRESS, DONE. Defaults to TODO")
            @Nullable String status,
            @ToolArg(description = "One of LOW, MEDIUM, HIGH. Defaults to MEDIUM")
            @Nullable String priority) {
        try {
            return ok(tasks.create(new TaskDtos.TaskRequest(title, description, status, priority)));
        } catch (HttpClientResponseException e) {
            return apiError(e);
        }
    }

    /**
     * The description spells out the replace semantics on purpose. This is a PUT underneath, and a
     * model that assumes patch semantics will wipe a task's priority while "just fixing the
     * title". The tool description is the only place it can learn that.
     */
    @Tool(name = "tasks_update", description =
            "Replace a task. This is a full replace, NOT a patch: any field you omit is reset to "
            + "its default rather than left unchanged. Omitting description clears it; omitting "
            + "status resets it to TODO; omitting priority resets it to MEDIUM. To change one "
            + "field, call tasks_get first and pass every other value back unchanged.")
    public CallToolResult update(
            @ToolArg(description = "The task's UUID") String id,
            @ToolArg(description = "Short title. Required, max 200 characters") String title,
            @ToolArg(description = "Optional longer description. Omit to clear it")
            @Nullable String description,
            @ToolArg(description = "One of TODO, IN_PROGRESS, DONE. Omit to reset to TODO")
            @Nullable String status,
            @ToolArg(description = "One of LOW, MEDIUM, HIGH. Omit to reset to MEDIUM")
            @Nullable String priority) {
        try {
            // Same 404-becomes-null behaviour as tasks_get.
            TaskDtos.TaskResponse task =
                    tasks.update(id, new TaskDtos.TaskRequest(title, description, status, priority));
            return task == null ? notFound(id) : ok(task);
        } catch (HttpClientResponseException e) {
            if (e.getStatus().getCode() == 404) {
                return notFound(id);
            }
            return apiError(e);
        }
    }

    @Tool(name = "tasks_delete", description =
            "Delete a task. Idempotent: it succeeds whether or not the task existed, so a repeat "
            + "call is not an error.")
    public CallToolResult delete(@ToolArg(description = "The task's UUID") String id) {
        try {
            tasks.delete(id);
            return CallToolResult.builder()
                    .addTextContent("Deleted task " + id + " (or it did not exist).")
                    .isError(false)
                    .build();
        } catch (HttpClientResponseException e) {
            return apiError(e);
        }
    }

    private CallToolResult ok(Object payload) {
        try {
            return CallToolResult.builder()
                    .addTextContent(json.writeValueAsString(payload))
                    .isError(false)
                    .build();
        } catch (Exception e) {
            return error("Could not serialize the task API's response: " + e.getMessage());
        }
    }

    private static CallToolResult notFound(String id) {
        return error("No task with id '" + id + "'. Call tasks_list to see valid ids.");
    }

    private static CallToolResult error(String message) {
        return CallToolResult.builder().addTextContent(message).isError(true).build();
    }

    /**
     * Translates a task API failure into something a model can act on. A 400 means the arguments
     * were wrong and are worth retrying differently; anything else is not the caller's fault.
     */
    private static CallToolResult apiError(HttpClientResponseException e) {
        int code = e.getStatus().getCode();
        if (code == 400) {
            return error("The task API rejected the request. Check that title is non-blank and "
                    + "under 200 characters, status is one of TODO/IN_PROGRESS/DONE, and priority "
                    + "is one of LOW/MEDIUM/HIGH.");
        }
        return error("The task API returned HTTP " + code + ". This is not something the arguments "
                + "can fix; the service may be down.");
    }
}
