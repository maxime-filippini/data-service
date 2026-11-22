import { Clock, Effect, Layer } from "effect";

import {
  type CheckpointDelay,
  Checkpointer,
  type Json,
  type StepPolicy,
} from "$/workflows/checkpointer";
import {
  type StepFailure,
  defectsAsTransient,
  terminal,
} from "$/workflows/registry";

/**
 * Cloudflare's defaults when a checkpoint declares no policy: five retries,
 * ten seconds apart, growing exponentially.
 */
const PLATFORM_DEFAULT = {
  limit: 5,
  delay: 10_000,
  backoff: "exponential",
} as const;

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

const durationMs = (duration: CheckpointDelay) => {
  if (typeof duration === "number") return duration;
  const match = /^(\d+(?:\.\d+)?) (second|minute|hour|day|week)s?$/u.exec(
    duration,
  );
  if (match === null) throw new Error(`Unsupported duration "${duration}"`);
  return Number(match[1]) * UNIT_MS[match[2]!]!;
};

/** The delay before retry `retry` (1-based), following the policy. */
export const retryDelayMs = (policy: StepPolicy | undefined, retry: number) => {
  const retries = policy?.retries ?? PLATFORM_DEFAULT;
  const base = durationMs(retries.delay);
  switch (retries.backoff ?? "constant") {
    case "exponential":
      return base * 2 ** (retry - 1);
    case "linear":
      return base * retry;
    default:
      return base;
  }
};

/**
 * What the local Checkpointer did, for tracing. `replayed` returns a stored
 * result without running the body; `attempt` runs it; `stored` records a
 * successful result; `failed` is one failed attempt (`retrying` when the
 * policy allows another); `sleep` starts a durable sleep; `interrupted`
 * stops the execution before a checkpoint, as an eviction would.
 */
export type LocalCheckpointEvent =
  | {
      readonly type: "replayed";
      readonly name: string;
      readonly value: unknown;
    }
  | {
      readonly type: "attempt";
      readonly name: string;
      readonly attempt: number;
    }
  | { readonly type: "stored"; readonly name: string; readonly value: unknown }
  | {
      readonly type: "failed";
      readonly name: string;
      readonly attempt: number;
      readonly error: string;
      readonly retrying: boolean;
    }
  | { readonly type: "sleep"; readonly name: string; readonly until: number }
  | { readonly type: "interrupted"; readonly name: string };

/** Options for the local Checkpointer. */
export interface LocalCheckpointerOptions {
  /**
   * Scale applied to retry delays: 0 retries at once (tests), 1 waits as
   * long as the platform would.
   */
  readonly delayScale?: number;
  /**
   * Replaces a durable sleep: advance a test clock or wait for an external
   * test action. Without it, the sleep waits on the Clock until `at`.
   */
  readonly sleepUntil?: (at: number) => Promise<void>;
  /**
   * Called before a checkpoint or sleep that has no stored result. Returning
   * true interrupts the execution there, as an evicted isolate would: the
   * body never runs, and a later execution with the same stored results
   * replays up to that point.
   */
  readonly interruptBefore?: (name: string) => boolean;
  /** Notified of every checkpoint event, for tracing. */
  readonly onEvent?: (event: LocalCheckpointEvent) => void;
}

/**
 * The Checkpointer locally, with Cloudflare's rules: a successful result is
 * stored by name (as serialized JSON) and returned on replay without running
 * the body again; a transient failure is retried within the policy, a
 * terminal one is not. Stored results live in `checkpoints`, so a later
 * execution of the same instance can replay them. This only stands in for
 * the platform; it is not evidence of platform durability.
 */
export const localCheckpointer = (
  checkpoints: Map<string, string>,
  options: LocalCheckpointerOptions = {},
): typeof Checkpointer.Service => {
  const emit = (event: LocalCheckpointEvent) => options.onEvent?.(event);

  /** Return the stored result, interrupt, or run `fresh` and store it. */
  const once = <A, R>(
    name: string,
    fresh: Effect.Effect<A, StepFailure, R>,
  ): Effect.Effect<A, StepFailure, R> =>
    Effect.suspend(() => {
      const saved = checkpoints.get(name);
      if (saved !== undefined) {
        const value = JSON.parse(saved) as A;
        emit({ type: "replayed", name, value });
        return Effect.succeed(value);
      }
      if (options.interruptBefore?.(name) === true) {
        emit({ type: "interrupted", name });
        return Effect.interrupt;
      }
      return Effect.map(fresh, (result) => {
        const serialized = JSON.stringify(result ?? null);
        checkpoints.set(name, serialized);
        const value = JSON.parse(serialized) as A;
        emit({ type: "stored", name, value });
        return value;
      });
    });

  return Checkpointer.of({
    checkpoint: <A extends Json, R>(
      name: string,
      body: Effect.Effect<A, StepFailure, R>,
      policy?: StepPolicy,
    ) => {
      const limit = policy?.retries?.limit ?? PLATFORM_DEFAULT.limit;
      const attempt = (number: number): Effect.Effect<A, StepFailure, R> =>
        Effect.suspend(() => {
          emit({ type: "attempt", name, attempt: number });
          return defectsAsTransient(body);
        }).pipe(
          Effect.catch((failure) => {
            const retrying = failure.retry && number <= limit;
            emit({
              type: "failed",
              name,
              attempt: number,
              error: failure.message,
              retrying,
            });
            if (!retrying) return Effect.fail(terminal(failure.message));
            const delay =
              retryDelayMs(policy, number) * (options.delayScale ?? 1);
            return Effect.andThen(
              delay > 0 ? Effect.sleep(delay) : Effect.void,
              attempt(number + 1),
            );
          }),
        );
      return once(name, attempt(1));
    },
    sleepUntil: (name, at) =>
      once(
        name,
        Effect.gen(function* () {
          emit({ type: "sleep", name, until: at });
          if (options.sleepUntil !== undefined) {
            const wake = options.sleepUntil;
            yield* Effect.promise(() => wake(at));
          } else {
            const now = yield* Clock.currentTimeMillis;
            if (at > now) yield* Effect.sleep(at - now);
          }
          return null;
        }),
      ).pipe(Effect.asVoid, Effect.orDie),
  });
};

/** The local Checkpointer as a Layer. */
export const LocalCheckpointerLive = (
  checkpoints: Map<string, string>,
  options: LocalCheckpointerOptions = {},
): Layer.Layer<Checkpointer> =>
  Layer.succeed(Checkpointer, localCheckpointer(checkpoints, options));
