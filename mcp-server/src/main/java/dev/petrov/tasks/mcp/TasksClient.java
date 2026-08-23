package dev.petrov.tasks.mcp;

import io.micronaut.http.HttpResponse;
import io.micronaut.http.annotation.Body;
import io.micronaut.http.annotation.Delete;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Post;
import io.micronaut.http.annotation.Put;
import io.micronaut.http.client.annotation.Client;

import java.util.List;

/**
 * Declarative client against the task API.
 *
 * <p>Micronaut 5 no longer invokes {@code @Recoverable} fallbacks by default, which is the
 * behaviour we want: a failing task API must surface as an error the model can report, not as a
 * silently degraded empty result. Do not add micronaut-retry to bring the old behaviour back.
 */
@Client("${tasks.api.url}")
public interface TasksClient {

    @Get("/tasks")
    List<TaskDtos.TaskResponse> list();

    @Get("/tasks/{id}")
    TaskDtos.TaskResponse get(String id);

    @Post("/tasks")
    TaskDtos.TaskResponse create(@Body TaskDtos.TaskRequest request);

    @Put("/tasks/{id}")
    TaskDtos.TaskResponse update(String id, @Body TaskDtos.TaskRequest request);

    @Delete("/tasks/{id}")
    HttpResponse<Void> delete(String id);
}
