import { Effect } from "effect";

import type { TickReport } from "./dispatch";

export const reportDispatch = Effect.fn("WorkflowRuns.reportDispatch")(
  function* (report: TickReport) {
    if (report.status === "disabled") return report;
    for (const run of report.runs)
      yield* Effect.logInfo("workflow_dispatched").pipe(
        Effect.annotateLogs({ ...run }),
      );
    for (const failure of report.failures)
      yield* Effect.logError("workflow_dispatch_failed").pipe(
        Effect.annotateLogs({ ...failure }),
      );
    if (report.reconciled.failed > 0)
      yield* Effect.logInfo("workflow_runs_failed_as_stopped").pipe(
        Effect.annotateLogs({ count: report.reconciled.failed }),
      );
    return {
      status: report.status,
      reconciled: report.reconciled,
      dispatched: report.runs.length,
      failed: report.failures.length,
    };
  },
);
