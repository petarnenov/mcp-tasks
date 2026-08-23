package dev.petrov.tasks;

import io.micronaut.context.annotation.Factory;
import jakarta.inject.Singleton;

import java.time.Clock;

@Factory
public class ClockFactory {

    /** Injected rather than called statically so tests can substitute a fixed clock. */
    @Singleton
    Clock clock() {
        return Clock.systemUTC();
    }
}
