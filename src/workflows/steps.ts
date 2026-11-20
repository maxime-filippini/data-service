import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";

/** Retries and a timeout for a durable step's attempts. */
export type StepPolicy = WorkflowStepConfig;

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
 * The seam between orchestration and Cloudflare's durable step runner.
 * Results must be serializable. Successful results are stored, while failed
 * attempts may execute again, so step bodies must tolerate retries. A body
 * that throws `NonRetryableStepError` fails its step without further retries.
 */
export interface Steps {
  readonly do: <T extends Rpc.Serializable<T>>(
    name: string,
    run: () => Promise<T>,
    config?: WorkflowStepConfig,
  ) => Promise<T>;
}

export interface WorkflowSteps extends Steps {
  readonly sleepUntil: (name: string, timestamp: number) => Promise<void>;
}

/**
 * Thrown by a step body when retrying cannot help. Adapters translate it to
 * their runtime's non-retryable failure (Cloudflare's `NonRetryableError`).
 */
export class NonRetryableStepError extends Error {
  override readonly name = "NonRetryableStepError";
}

/**
 * Keep the platform's overload/argument order out of the orchestration code.
 * `nonRetryable` converts a `NonRetryableStepError` into the platform's own
 * error; it is passed in because `cloudflare:workflows` only loads in the
 * Workers runtime.
 */
export const workflowSteps = (
  step: WorkflowStep,
  nonRetryable: (error: NonRetryableStepError) => Error = (error) => error,
): WorkflowSteps => ({
  do: (name, run, config) => {
    const body = () =>
      run().catch((error: unknown) => {
        throw error instanceof NonRetryableStepError
          ? nonRetryable(error)
          : error;
      });
    return config === undefined
      ? step.do(name, body)
      : step.do(name, config, body);
  },
  sleepUntil: (name, timestamp) => step.sleepUntil(name, timestamp),
});
