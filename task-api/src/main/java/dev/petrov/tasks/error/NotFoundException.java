package dev.petrov.tasks.error;

public class NotFoundException extends RuntimeException {

    public NotFoundException(String id) {
        super("No task with id '" + id + "'");
    }
}
