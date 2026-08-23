package dev.petrov.tasks;

import dev.petrov.tasks.domain.Task;
import dev.petrov.tasks.domain.TaskPriority;
import dev.petrov.tasks.domain.TaskStatus;
import dev.petrov.tasks.dto.CreateTaskRequest;
import dev.petrov.tasks.dto.TaskResponse;
import dev.petrov.tasks.dto.UpdateTaskRequest;
import dev.petrov.tasks.error.NotFoundException;
import jakarta.inject.Singleton;
import jakarta.transaction.Transactional;

import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.stream.StreamSupport;

@Singleton
public class TaskService {

    private final TaskRepository repository;
    private final Timestamps timestamps;

    public TaskService(TaskRepository repository, Timestamps timestamps) {
        this.repository = repository;
        this.timestamps = timestamps;
    }

    @Transactional
    public TaskResponse create(CreateTaskRequest request) {
        String now = timestamps.now();
        Task task = new Task(
                UUID.randomUUID().toString(),
                request.title(),
                request.description(),
                Objects.requireNonNullElse(request.status(), TaskStatus.DEFAULT),
                Objects.requireNonNullElse(request.priority(), TaskPriority.DEFAULT),
                now,
                now
        );
        return TaskResponse.from(repository.save(task));
    }

    @Transactional
    public List<TaskResponse> list() {
        return StreamSupport.stream(repository.findAll().spliterator(), false)
                .map(TaskResponse::from)
                .toList();
    }

    @Transactional
    public TaskResponse get(String id) {
        return repository.findById(id)
                .map(TaskResponse::from)
                .orElseThrow(() -> new NotFoundException(id));
    }

    /**
     * Full replace. Omitted fields go back to their defaults rather than keeping their old values —
     * that is what PUT means, and it is why there is no "was this omitted or explicitly nulled?"
     * ambiguity to resolve. Only id and createdAt survive from the stored row.
     */
    @Transactional
    public TaskResponse update(String id, UpdateTaskRequest request) {
        Task existing = repository.findById(id).orElseThrow(() -> new NotFoundException(id));
        Task replaced = new Task(
                existing.id(),
                request.title(),
                request.description(),
                Objects.requireNonNullElse(request.status(), TaskStatus.DEFAULT),
                Objects.requireNonNullElse(request.priority(), TaskPriority.DEFAULT),
                existing.createdAt(),
                timestamps.nextAfter(existing.updatedAt())
        );
        return TaskResponse.from(repository.update(replaced));
    }

    /**
     * Idempotent: deleting an unknown or malformed id is a no-op, not an error. A client that
     * times out and retries gets the same answer both times.
     */
    @Transactional
    public void delete(String id) {
        repository.deleteById(id);
    }
}
