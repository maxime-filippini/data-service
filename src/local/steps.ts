import type { WorkflowStepConfig } from "cloudflare:workers";

import { NonRetryableStepError, type WorkflowSteps } from "$/workflows/steps";

/**
 * Cloudflare's defaults when a step declares no policy: five retries, ten
 * seconds apart, growing exponentially.
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

const durationMs = (duration: string | number) => {
  if (typeof duration === "number") return duration;
  const match = /^(\d+(?:\.\d+)?) (second|minute|hour|day|week)s?$/u.exec(
    duration,
  );
  if (match === null) throw new Error(`Unsupported duration "${duration}"`);
  return Number(match[1]) * UNIT_MS[match[2]!]!;
};

/** The delay before retry `retry` (1-based), following the step's policy. */
export const retryDelayMs = (
  config: WorkflowStepConfig | undefined,
  retry: number,
) => {
  const retries = config?.retries ?? PLATFORM_DEFAULT;
  if (typeof retries.delay === "function")
    throw new Error("Dynamic retry delays are not supported locally");
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
 * What the local Steps adapter did, for tracing. `replayed` returns a stored
 * result without running the body; `attempt` runs it; `stored` records a
 * successful result; `failed` is one failed attempt (`retrying` when the
 * policy allows another); `sleep` starts a durable sleep; `interrupted`
 * stops the execution before a step, as an eviction would.
 */
export type LocalStepEvent =
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

/** Options for local step execution. */
export interface LocalStepsOptions {
  /**
   * Scale applied to retry delays: 0 retries at once (tests), 1 waits as
   * long as the platform would.
   */
  readonly delayScale?: number;
  /** Advance a test clock or block on an external test action until wake. */
  readonly sleepUntil?: (timestamp: number) => Promise<void>;
  /**
   * Called before a step that has no checkpoint runs. Returning true stops
   * this execution there, as an evicted isolate would: the step never runs
   * and `do` never settles. A later execution with the same checkpoints
   * replays from that point.
   */
  readonly interruptBefore?: (name: string) => boolean;
  /** Notified when `interruptBefore` stops the execution. */
  readonly onInterrupt?: (name: string) => void;
  /** Notified of every checkpoint event, for tracing. */
  readonly onEvent?: (event: LocalStepEvent) => void;
}

/**
 * The durable Steps adapter's local implementation, with Cloudflare's
 * semantics: a successful result is checkpointed by step name (as
 * serialized JSON) and returned on replay without running the body again;
 * a failed body is retried within the step's policy unless it threw
 * `NonRetryableStepError`, then the last error is thrown. This only stands
 * in for the platform locally; it is not evidence of platform durability.
 */
export const localSteps = (
  checkpoints: Map<string, string>,
  options: LocalStepsOptions = {},
): WorkflowSteps => {
  const checkpoint = async <T>(
    name: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const saved = checkpoints.get(name);
    if (saved !== undefined) {
      const value = JSON.parse(saved);
      options.onEvent?.({ type: "replayed", name, value });
      return value;
    }
    if (options.interruptBefore?.(name) === true) {
      options.onEvent?.({ type: "interrupted", name });
      options.onInterrupt?.(name);
      return new Promise<never>(() => {});
    }
    const serialized = JSON.stringify((await run()) ?? null);
    checkpoints.set(name, serialized);
    const value = JSON.parse(serialized);
    options.onEvent?.({ type: "stored", name, value });
    return value;
  };

  return {
    do: (name, run, config) =>
      checkpoint(name, async () => {
        const limit = config?.retries?.limit ?? PLATFORM_DEFAULT.limit;
        for (let attempt = 1; ; attempt += 1) {
          options.onEvent?.({ type: "attempt", name, attempt });
          try {
            return await run();
          } catch (error) {
            const retrying = !(
              error instanceof NonRetryableStepError || attempt > limit
            );
            options.onEvent?.({
              type: "failed",
              name,
              attempt,
              error: error instanceof Error ? error.message : String(error),
              retrying,
            });
            if (!retrying) throw error;
            const delay =
              retryDelayMs(config, attempt) * (options.delayScale ?? 1);
            if (delay > 0) await new Promise((wake) => setTimeout(wake, delay));
          }
        }
      }),
    sleepUntil: async (name, timestamp) => {
      await checkpoint(name, async () => {
        options.onEvent?.({ type: "sleep", name, until: timestamp });
        if (options.sleepUntil !== undefined) {
          await options.sleepUntil(timestamp);
        } else {
          const delay = timestamp - Date.now();
          if (delay > 0) await new Promise((wake) => setTimeout(wake, delay));
        }
        return null;
      });
    },
  };
};
