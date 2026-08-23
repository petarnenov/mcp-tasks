package dev.petrov.tasks.mcp;

import io.micronaut.core.annotation.Nullable;
import io.micronaut.serde.annotation.Serdeable;

/**
 * Wire types mirroring the task API.
 *
 * <p>Deliberately duplicated rather than shared through a third module: this server is a client of
 * the API over HTTP, and a shared type would let a change on one side silently bind the other. The
 * duplication is the seam.
 */
public final class TaskDtos {

    private TaskDtos() {
    }

    @Serdeable
    public record TaskResponse(
            String id,
            String title,
            @Nullable String description,
            String status,
            String priority,
            String createdAt,
            String updatedAt
    ) {
    }

    @Serdeable
    public record TaskRequest(
            String title,
            @Nullable String description,
            @Nullable String status,
            @Nullable String priority
    ) {
    }
}
