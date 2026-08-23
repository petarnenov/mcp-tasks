package dev.petrov.tasks;

import dev.petrov.tasks.domain.Task;
import io.micronaut.data.jdbc.annotation.JdbcRepository;
import io.micronaut.data.model.query.builder.sql.Dialect;
import io.micronaut.data.repository.CrudRepository;

/**
 * Micronaut Data generates the implementation at compile time.
 *
 * <p>Dialect is ANSI, not SQLITE: Micronaut Data has no SQLite dialect (the enum offers MYSQL,
 * POSTGRES, SQL_SERVER, ORACLE, H2 and ANSI). Plain ANSI SQL is what these CRUD operations need
 * and SQLite accepts it.
 */
@JdbcRepository(dialect = Dialect.ANSI)
public interface TaskRepository extends CrudRepository<Task, String> {
}
