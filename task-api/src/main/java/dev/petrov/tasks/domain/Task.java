package dev.petrov.tasks.domain;

import io.micronaut.core.annotation.Nullable;
import io.micronaut.data.annotation.Id;
import io.micronaut.data.annotation.MappedEntity;
import io.micronaut.data.annotation.MappedProperty;
import io.micronaut.data.model.DataType;

/**
 * A persisted task row.
 *
 * <p>The id is a server-assigned UUID string, never database-generated: ids stay stable and do not
 * depend on SQLite's rowid semantics. Timestamps are fixed-width ISO-8601 UTC strings rather than
 * a temporal type — SQLite has no native date type, and text stays readable in the sqlite3 CLI.
 * Fixed width also means lexicographic comparison equals chronological comparison.
 */
@MappedEntity("tasks")
public record Task(
        @Id String id,
        String title,
        @Nullable String description,
        @MappedProperty(type = DataType.STRING) TaskStatus status,
        @MappedProperty(type = DataType.STRING) TaskPriority priority,
        String createdAt,
        String updatedAt
) {
}
