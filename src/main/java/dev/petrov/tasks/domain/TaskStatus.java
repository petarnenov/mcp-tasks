package dev.petrov.tasks.domain;

import io.micronaut.serde.annotation.Serdeable;

@Serdeable
public enum TaskStatus {
    TODO,
    IN_PROGRESS,
    DONE;

    public static final TaskStatus DEFAULT = TODO;
}
