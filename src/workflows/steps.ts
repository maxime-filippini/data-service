import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";

/**
 * The seam between orchestration and Cloudflare's durable step runner.
 * Results must be serializable. Successful results are stored, while failed
 * attempts may execute again, so step bodies must tolerate retries.
 */
export interface Steps {
  readonly do: <T extends Rpc.Serializable<T>>(
    name: string,
    run: () => Promise<T>,
    config?: WorkflowStepConfig,
  ) => Promise<T>;
}

/** Keep the platform's overload/argument order out of the orchestration code. */
export const workflowSteps = (step: WorkflowStep): Steps => ({
  do: (name, run, config) =>
    config === undefined ? step.do(name, run) : step.do(name, config, run),
});
