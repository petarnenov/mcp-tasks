package dev.petrov.tasks.dto;

import dev.petrov.tasks.domain.TaskPriority;
import dev.petrov.tasks.domain.TaskStatus;
import io.micronaut.core.annotation.Nullable;
import io.micronaut.serde.annotation.Serdeable;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Input for POST /tasks.
 *
 * <p>Deliberately does not carry {@code id}, {@code createdAt} or {@code updatedAt}: a client
 * cannot supply them because there is nowhere to put them.
 */
@Serdeable
public record CreateTaskRequest(
        @NotBlank @Size(max = 200) String title,
        @Nullable @Size(max = 2000) String description,
        @Nullable TaskStatus status,
        @Nullable TaskPriority priority
) {
}
