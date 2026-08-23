package dev.petrov.tasks.error;

import io.micronaut.context.annotation.Requires;
import io.micronaut.http.HttpRequest;
import io.micronaut.http.HttpResponse;
import io.micronaut.http.annotation.Produces;
import io.micronaut.http.server.exceptions.ExceptionHandler;
import jakarta.inject.Singleton;

/**
 * Turns a missing task into a 404 with a JSON body, rather than letting it surface as a 500 with a
 * stack trace.
 */
@Produces
@Singleton
@Requires(classes = {NotFoundException.class, ExceptionHandler.class})
public class NotFoundExceptionHandler
        implements ExceptionHandler<NotFoundException, HttpResponse<ApiError>> {

    @Override
    public HttpResponse<ApiError> handle(HttpRequest request, NotFoundException exception) {
        return HttpResponse.notFound(new ApiError("Not Found", exception.getMessage()));
    }
}
