import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import { D1WorkflowRunsLive } from "$/workflows/runs/d1";
import {
  scheduledWorkflowTick,
  type WorkflowDispatchParams,
} from "$/workflows/runs/dispatch";
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
    if (report.status === "disabled") return report;
    for (const run of report.runs)
      console.log(JSON.stringify({ event: "workflow_dispatched", ...run }));
    for (const failure of report.failures)
      console.error(
        JSON.stringify({ event: "workflow_dispatch_failed", ...failure }),
      );
    if (report.reconciled.failed > 0)
      console.log(
        JSON.stringify({
          event: "workflow_runs_failed_as_stopped",
          count: report.reconciled.failed,
        }),
      );
    return {
      status: report.status,
      reconciled: report.reconciled,
      dispatched: report.runs.length,
      failed: report.failures.length,
    };
  }
}
