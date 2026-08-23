package dev.petrov.tasks.domain;

import io.micronaut.serde.annotation.Serdeable;

@Serdeable
public enum TaskPriority {
    LOW,
    MEDIUM,
    HIGH;

    public static final TaskPriority DEFAULT = MEDIUM;
}
