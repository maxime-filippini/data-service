import { Clock, Duration, Effect } from "effect";

/**
 * The current time as an ISO timestamp, read from Effect's `Clock` service so
 * that run records, wait deadlines and publications share one clock.
 */
export const nowIso: Effect.Effect<string> = Effect.map(
  Clock.currentTimeMillis,
  (ms) => new Date(ms).toISOString(),
);

/**
 * A `Clock` whose wall time is `now()`, for local runs and tests that move
 * time themselves (a durable sleep jumps it forward). Monotonic time and
 * `sleep` stay real.
 */
export const clockAt = (now: () => number): Clock.Clock => {
  const nanos = () => BigInt(Math.round(now())) * 1_000_000n;
  const monotonic = () => BigInt(Math.round(performance.now() * 1_000_000));
  return {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: monotonic,
    monotonicTimeNanos: Effect.sync(monotonic),
    sleep: (duration) =>
      Effect.promise(
        () =>
          new Promise<void>((wake) =>
            setTimeout(wake, Duration.toMillis(duration)),
          ),
      ),
  };
};
