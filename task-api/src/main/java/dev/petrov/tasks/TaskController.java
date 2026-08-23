package dev.petrov.tasks;

import dev.petrov.tasks.dto.CreateTaskRequest;
import dev.petrov.tasks.dto.TaskResponse;
import dev.petrov.tasks.dto.UpdateTaskRequest;
import io.micronaut.http.HttpResponse;
import io.micronaut.http.MediaType;
import io.micronaut.http.annotation.Body;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Delete;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Post;
import io.micronaut.http.annotation.Put;
import io.micronaut.validation.Validated;
import jakarta.validation.Valid;

import java.net.URI;
import java.util.List;

@Validated
@Controller("/tasks")
public class TaskController {

    private final TaskService service;

    public TaskController(TaskService service) {
        this.service = service;
    }

    @Post(consumes = MediaType.APPLICATION_JSON, produces = MediaType.APPLICATION_JSON)
    public HttpResponse<TaskResponse> create(@Body @Valid CreateTaskRequest request) {
        TaskResponse created = service.create(request);
        return HttpResponse.created(created, URI.create("/tasks/" + created.id()));
    }

    @Get(produces = MediaType.APPLICATION_JSON)
    public List<TaskResponse> list() {
        return service.list();
    }

    @Get(uri = "/{id}", produces = MediaType.APPLICATION_JSON)
    public TaskResponse get(String id) {
        return service.get(id);
    }

    @Put(uri = "/{id}", consumes = MediaType.APPLICATION_JSON, produces = MediaType.APPLICATION_JSON)
    public TaskResponse update(String id, @Body @Valid UpdateTaskRequest request) {
        return service.update(id, request);
    }

    /** Always 204 — see {@link TaskService#delete(String)}. */
    @Delete("/{id}")
    public HttpResponse<Void> delete(String id) {
        service.delete(id);
        return HttpResponse.noContent();
    }
}
