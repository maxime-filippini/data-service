import { Context, type Effect } from "effect";

import type { StepFailure } from "$/workflows/registry";

/**
 * A JSON value a checkpoint can store. Kept shallow: a recursive JSON type
 * is too deep for the Workers runtime's serializable check.
 */
export type Json = {} | null;

/** A checkpoint's retry delay: milliseconds, or a duration like "10 seconds". */
export type CheckpointDelay = number | `${number} ${DurationUnit}`;

type DurationUnit =
  | "second"
  | "seconds"
  | "minute"
  | "minutes"
  | "hour"
  | "hours"
  | "day"
  | "days"
  | "week"
  | "weeks";

/** Retries and a timeout for a checkpoint's attempts. */
export interface StepPolicy {
  readonly retries?: {
    readonly limit: number;
    readonly delay: CheckpointDelay;
    readonly backoff?: "constant" | "linear" | "exponential";
  };
  readonly timeout?: CheckpointDelay;
}

/**
 * The executor's step policy unless its environment supplies another: three
 * retries with exponential backoff (10 s, 20 s, 40 s) for transient
 * failures, and a 10-minute timeout per attempt. Terminal failures are never
 * retried, whatever the policy.
 */
export const DEFAULT_STEP_POLICY = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const satisfies StepPolicy;

/**
 * Durable execution for one Workflow instance: the seam between
 * orchestration and the platform that stores its progress (Cloudflare
 * Workflows, or a map locally).
 *
 * A checkpoint runs its body once and stores the result under its name. When
 * the instance's body runs again (after a sleep, an eviction or a retry), a
 * checkpoint that already has a result returns it without running the body,
 * so code between checkpoints must be deterministic and anything that reads
 * the outside world belongs inside one.
 */
export class Checkpointer extends Context.Service<
  Checkpointer,
  {
    /**
     * Run `body` once and store its result under `name`, or return the
     * result stored by an earlier execution. A transient failure is retried
     * within `policy` (the platform's default without one); a terminal
     * failure is not. When the checkpoint gives up, it fails with the last
     * failure, as terminal.
     */
    readonly checkpoint: <A extends Json, R>(
      name: string,
      body: Effect.Effect<A, StepFailure, R>,
      policy?: StepPolicy,
    ) => Effect.Effect<A, StepFailure, R>;
    /**
     * Sleep until `at` (Unix milliseconds) durably: the instance may be
     * evicted meanwhile, and a later execution continues after the sleep.
     */
    readonly sleepUntil: (name: string, at: number) => Effect.Effect<void>;
  }
>()("data-service/Checkpointer") {}
