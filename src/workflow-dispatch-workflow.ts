import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect } from "effect";

import { cloudflareServices } from "$/dependencies";
import { WorkerLoggerLive } from "$/logging";
import { cloudflareCheckpointer } from "$/workflows/cloudflare";
import { scheduledWorkflowTick } from "$/workflows/runs/coordinator";
import type { WorkflowDispatchParams } from "$/workflows/runs/dispatch";
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
      cloudflareServices(this.env),
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
