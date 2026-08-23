package dev.petrov.tasks.error;

import io.micronaut.serde.annotation.Serdeable;

@Serdeable
public record ApiError(String error, String message) {
}
