package dev.petrov.tasks.dto;

import dev.petrov.tasks.domain.TaskPriority;
import dev.petrov.tasks.domain.TaskStatus;
import io.micronaut.core.annotation.Nullable;
import io.micronaut.serde.annotation.Serdeable;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Input for PUT /tasks/{id}.
 *
 * <p>PUT is a full replace: an omitted field is not "leave it alone", it is "set it to the
 * default". Omitting description clears it; omitting status or priority resets them. Same shape as
 * {@link CreateTaskRequest} for exactly that reason — a replace takes the same body as a create.
 */
@Serdeable
public record UpdateTaskRequest(
        @NotBlank @Size(max = 200) String title,
        @Nullable @Size(max = 2000) String description,
        @Nullable TaskStatus status,
        @Nullable TaskPriority priority
) {
}
