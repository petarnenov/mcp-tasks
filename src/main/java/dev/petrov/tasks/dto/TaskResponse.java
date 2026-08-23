package dev.petrov.tasks.dto;

import dev.petrov.tasks.domain.Task;
import dev.petrov.tasks.domain.TaskPriority;
import dev.petrov.tasks.domain.TaskStatus;
import io.micronaut.core.annotation.Nullable;
import io.micronaut.serde.annotation.Serdeable;

@Serdeable
public record TaskResponse(
        String id,
        String title,
        @Nullable String description,
        TaskStatus status,
        TaskPriority priority,
        String createdAt,
        String updatedAt
) {
    public static TaskResponse from(Task task) {
        return new TaskResponse(
                task.id(),
                task.title(),
                task.description(),
                task.status(),
                task.priority(),
                task.createdAt(),
                task.updatedAt()
        );
    }
}
