package dev.petrov.tasks;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TimestampsTest {

    private static final Instant FIXED = Instant.parse("2026-08-23T10:15:30.123456Z");

    @Test
    @DisplayName("timestamps are fixed-width ISO-8601 UTC with six fractional digits")
    void formatIsFixedWidth() {
        Timestamps timestamps = new Timestamps(Clock.fixed(FIXED, ZoneOffset.UTC));
        assertEquals("2026-08-23T10:15:30.123456Z", timestamps.now());

        // A whole-second instant must still print six digits, or lexicographic ordering breaks.
        Timestamps onTheSecond =
                new Timestamps(Clock.fixed(Instant.parse("2026-08-23T10:15:30Z"), ZoneOffset.UTC));
        assertEquals("2026-08-23T10:15:30.000000Z", onTheSecond.now());
        assertEquals(timestamps.now().length(), onTheSecond.now().length());
    }

    @Test
    @DisplayName("nextAfter advances even when the clock has not moved")
    void nextAfterAlwaysAdvances() {
        Timestamps frozen = new Timestamps(Clock.fixed(FIXED, ZoneOffset.UTC));

        String first = frozen.now();
        String second = frozen.nextAfter(first);
        String third = frozen.nextAfter(second);

        assertTrue(second.compareTo(first) > 0, first + " -> " + second);
        assertTrue(third.compareTo(second) > 0, second + " -> " + third);
        assertEquals("2026-08-23T10:15:30.123457Z", second);
    }

    @Test
    @DisplayName("nextAfter uses the real clock when it has moved on")
    void nextAfterPrefersTheClock() {
        Timestamps timestamps = new Timestamps(Clock.fixed(FIXED, ZoneOffset.UTC));
        String stale = "2020-01-01T00:00:00.000000Z";
        assertEquals("2026-08-23T10:15:30.123456Z", timestamps.nextAfter(stale));
    }

    @Test
    @DisplayName("lexicographic order matches chronological order")
    void lexicographicOrderMatchesTime() {
        Timestamps early =
                new Timestamps(Clock.fixed(Instant.parse("2026-08-23T10:15:30.000000Z"), ZoneOffset.UTC));
        Timestamps late =
                new Timestamps(Clock.fixed(Instant.parse("2026-08-23T10:15:30.500000Z"), ZoneOffset.UTC));

        assertTrue(early.now().compareTo(late.now()) < 0);
    }
}
