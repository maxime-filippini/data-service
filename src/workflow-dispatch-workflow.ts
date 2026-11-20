import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Effect } from "effect";

import { WorkerLoggerLive } from "$/logging";
import { D1WorkflowRunsLive } from "$/workflows/runs/d1";
import {
  scheduledWorkflowTick,
  type WorkflowDispatchParams,
} from "$/workflows/runs/dispatch";
import { reportDispatch } from "$/workflows/runs/report";
import { workflowSteps } from "$/workflows/steps";

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
        runPlatformFor: (env) => env.WORKFLOW_RUNS,
      },
      this.env,
      new Date(event.payload.scheduledTime),
      workflowSteps(step),
    );
    return reportDispatch(report).pipe(
      Effect.provide(WorkerLoggerLive),
      Effect.runPromise,
    );
  }
}
