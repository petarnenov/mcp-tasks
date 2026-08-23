package dev.petrov.tasks;

import dev.petrov.tasks.domain.Task;
import io.micronaut.data.jdbc.annotation.JdbcRepository;
import io.micronaut.data.model.query.builder.sql.Dialect;
import io.micronaut.data.repository.CrudRepository;

/**
 * Micronaut Data generates the implementation at compile time.
 *
 * <p>Dialect was ANSI until 2026-08-23, because Micronaut Data 4 had no SQLite dialect. Micronaut
 * Data 5 added one, so this now says what it means.
 */
@JdbcRepository(dialect = Dialect.SQLITE)
public interface TaskRepository extends CrudRepository<Task, String> {
}
