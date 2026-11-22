import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect } from "effect";

import { WorkerLoggerLive } from "$/logging";
import { cloudflareCheckpointer } from "$/workflows/cloudflare";
import { D1WorkflowRunsLive } from "$/workflows/runs/d1";
import {
  scheduledWorkflowTick,
  type WorkflowDispatchParams,
} from "$/workflows/runs/dispatch";
import { BindingRunLauncherLive } from "$/workflows/runs/launcher";
import { reportDispatch } from "$/workflows/runs/report";

export class WorkflowDispatchWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  WorkflowDispatchParams
> {
  override async run(
    event: WorkflowEvent<WorkflowDispatchParams>,
    step: WorkflowStep,
  ) {
    const report = await scheduledWorkflowTick(
      {
        workflowRunsFor: (env) => D1WorkflowRunsLive(env.MARKET_DATA_DB),
        runLauncherFor: (env) => BindingRunLauncherLive(env.WORKFLOW_RUNS),
      },
      this.env,
      new Date(event.payload.scheduledTime),
      cloudflareCheckpointer(step, (message) => new NonRetryableError(message)),
    );
    return reportDispatch(report).pipe(
      Effect.provide(WorkerLoggerLive),
      Effect.runPromise,
    );
  }
}
