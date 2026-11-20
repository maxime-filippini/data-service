import type { WorkflowStepConfig } from "cloudflare:workers";

import { NonRetryableStepError, type Steps } from "$/workflows/steps";

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

/** Options for local step execution. */
export interface LocalStepsOptions {
  /**
   * Scale applied to retry delays: 0 retries at once (tests), 1 waits as
   * long as the platform would.
   */
  readonly delayScale?: number;
  /**
   * Called before a step that has no checkpoint runs. Returning true stops
   * this execution there, as an evicted isolate would: the step never runs
   * and `do` never settles. A later execution with the same checkpoints
   * replays from that point.
   */
  readonly interruptBefore?: (name: string) => boolean;
  /** Notified when `interruptBefore` stops the execution. */
  readonly onInterrupt?: (name: string) => void;
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
): Steps => ({
  do: async (name, run, config) => {
    const saved = checkpoints.get(name);
    if (saved !== undefined) return JSON.parse(saved);
    if (options.interruptBefore?.(name) === true) {
      options.onInterrupt?.(name);
      return new Promise<never>(() => {});
    }
    const limit = config?.retries?.limit ?? PLATFORM_DEFAULT.limit;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await run();
        const serialized = JSON.stringify(result ?? null);
        checkpoints.set(name, serialized);
        return JSON.parse(serialized);
      } catch (error) {
        if (error instanceof NonRetryableStepError || attempt > limit)
          throw error;
        const delay = retryDelayMs(config, attempt) * (options.delayScale ?? 1);
        if (delay > 0) await new Promise((wake) => setTimeout(wake, delay));
      }
    }
  },
});
