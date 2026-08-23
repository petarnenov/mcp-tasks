package dev.petrov.tasks;

import jakarta.inject.Singleton;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

/**
 * Produces the ISO-8601 UTC strings stored in created_at / updated_at.
 *
 * <p>Always six fractional digits, so every timestamp is the same width. That matters: fixed width
 * is what makes lexicographic string comparison agree with chronological order, which in turn lets
 * the column be compared and sorted as plain TEXT.
 */
@Singleton
public class Timestamps {

    private static final DateTimeFormatter ISO_MICROS =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSSSS'Z'").withZone(ZoneOffset.UTC);

    private final Clock clock;

    public Timestamps(Clock clock) {
        this.clock = clock;
    }

    public String now() {
        return ISO_MICROS.format(clock.instant());
    }

    /**
     * The next timestamp strictly after {@code previous}.
     *
     * <p>Normally this is simply "now". The fallback exists because two updates inside the same
     * microsecond would otherwise produce an unchanged updatedAt, which would make "updatedAt
     * advances on every update" true only most of the time. Bumping by one microsecond makes the
     * guarantee hold always, instead of depending on how fast the machine is.
     */
    public String nextAfter(String previous) {
        Instant prior = Instant.parse(previous);
        Instant now = clock.instant();
        Instant next = now.isAfter(prior) ? now : prior.plusNanos(1_000);
        return ISO_MICROS.format(next);
    }
}
