package dev.petrov.tasks.mcp;

import io.micronaut.context.annotation.Requires;
import io.micronaut.http.HttpResponse;
import io.micronaut.http.HttpStatus;
import io.micronaut.http.annotation.Body;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Delete;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Post;
import io.micronaut.http.annotation.Put;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

/**
 * A stand-in for the task API, served from the same context as the MCP server under test.
 *
 * <p>Deliberately a real HTTP endpoint rather than a mocked {@link TasksClient}: the thing worth
 * testing is the whole path — MCP request, tool dispatch, HTTP call, response translation. A mock
 * at the client boundary would skip the half most likely to break.
 *
 * <p>It reproduces the task API's contract only as far as these tests need: 404 for an unknown id
 * and 400 for a blank title.
 */
@Requires(property = "stub.tasks.enabled", value = "true")
@Controller("/tasks")
public class StubTasksApi {

    private final List<TaskDtos.TaskResponse> store = new ArrayList<>();

    @Get
    public List<TaskDtos.TaskResponse> list() {
        return List.copyOf(store);
    }

    @Get("/{id}")
    public HttpResponse<TaskDtos.TaskResponse> get(String id) {
        return store.stream()
                .filter(t -> t.id().equals(id))
                .findFirst()
                .map(HttpResponse::ok)
                .orElseGet(HttpResponse::notFound);
    }

    @Post
    public HttpResponse<TaskDtos.TaskResponse> create(@Body TaskDtos.TaskRequest request) {
        if (request.title() == null || request.title().isBlank()) {
            return HttpResponse.status(HttpStatus.BAD_REQUEST);
        }
        TaskDtos.TaskResponse created = new TaskDtos.TaskResponse(
                UUID.randomUUID().toString(),
                request.title(),
                request.description(),
                Objects.requireNonNullElse(request.status(), "TODO"),
                Objects.requireNonNullElse(request.priority(), "MEDIUM"),
                "2026-08-23T00:00:00.000000Z",
                "2026-08-23T00:00:00.000000Z");
        store.add(created);
        return HttpResponse.created(created);
    }

    @Put("/{id}")
    public HttpResponse<TaskDtos.TaskResponse> update(String id, @Body TaskDtos.TaskRequest request) {
        for (int i = 0; i < store.size(); i++) {
            if (store.get(i).id().equals(id)) {
                // Full replace, mirroring the real API: omitted fields go back to defaults.
                TaskDtos.TaskResponse replaced = new TaskDtos.TaskResponse(
                        id,
                        request.title(),
                        request.description(),
                        Objects.requireNonNullElse(request.status(), "TODO"),
                        Objects.requireNonNullElse(request.priority(), "MEDIUM"),
                        store.get(i).createdAt(),
                        "2026-08-23T00:00:01.000000Z");
                store.set(i, replaced);
                return HttpResponse.ok(replaced);
            }
        }
        return HttpResponse.notFound();
    }

    @Delete("/{id}")
    public HttpResponse<Void> delete(String id) {
        store.removeIf(t -> t.id().equals(id));
        return HttpResponse.noContent();
    }
}
