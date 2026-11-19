import { Effect, type Layer } from "effect";

import { failStoppedRuns } from "$/calculations/runs";
import { triggerScheduledCalculations } from "$/calculations/schedule";
import type { Dependencies } from "$/dependencies";
import { WorkerLoggerLive } from "$/logging";
import { type MarketDataControlPlane } from "$/market-data/control-plane";
import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import { scheduleProcessing } from "$/market-data/processing";
import { triggerScheduledRun } from "$/market-data/schedule/operations";
import {
  type DispatchPlatform,
  startScheduledWorkflowTick,
  workflowDispatchEnabled,
} from "$/workflows/runs/dispatch";

/** The hour (UTC) at which the cron resends queued Parquet rebuilds. */
export const PROCESSING_SWEEP_HOUR = 2;

/** Dependency slice needed by the Worker's hourly scheduled handler. */
export type ScheduledDependencies = Pick<
  Dependencies,
  "scheduleFor" | "downloadWorkflowFor" | "calculationsFor" | "runWorkflowFor"
> & {
  readonly controlPlaneFor?: (
    env: CloudflareBindings,
  ) => Layer.Layer<MarketDataControlPlane, never, never>;
  /** Where the dispatch Workflow starts; the `WORKFLOW_DISPATCHES` binding by default. */
  readonly dispatchPlatformFor?: (env: CloudflareBindings) => DispatchPlatform;
};

/** Summary of one hourly scheduled invocation, including download ownership. */
export interface ScheduledHandlerOutcome {
  readonly downloadOwner: "workflows" | "legacy";
  readonly legacyDownload:
    | { readonly status: "skipped_for_workflows" }
    | { readonly status: "not_due" | "already_ran" }
    | { readonly status: "started"; readonly runId: string }
    | { readonly status: "failed"; readonly message: string };
  /** Whether this tick started the durable dispatch Workflow, which dispatches the due assignments. */
  readonly workflowTick:
    | Awaited<ReturnType<typeof startScheduledWorkflowTick>>
    | { readonly status: "failed"; readonly message: string };
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Execute the Worker's hourly scheduled tasks with strict mutual exclusion
 * between legacy download dispatch and workflow dispatch:
 *
 * - When `WORKFLOW_DISPATCH === "on"`, workflow dispatch owns automatic
 *   downloads and legacy `triggerScheduledRun` is never invoked (even if
 *   `download_schedule.paused` is 0).
 * - Otherwise, legacy `triggerScheduledRun` owns automatic downloads and
 *   workflow dispatch stays `disabled`.
 */
export const runScheduledHandlers = (
  now: Date,
  env: CloudflareBindings,
  deps: ScheduledDependencies,
): Promise<ScheduledHandlerOutcome> =>
  Effect.gen(function* () {
    const workflowsOwnDownloads = workflowDispatchEnabled(env);

    let legacyDownload: ScheduledHandlerOutcome["legacyDownload"];
    if (workflowsOwnDownloads) {
      legacyDownload = { status: "skipped_for_workflows" };
    } else {
      const trigger = yield* triggerScheduledRun(
        now,
        deps.downloadWorkflowFor(env),
      ).pipe(Effect.provide(deps.scheduleFor(env)), Effect.result);
      if (trigger._tag === "Success") {
        legacyDownload = trigger.success;
        if (trigger.success.status === "started")
          yield* Effect.logInfo("schedule_run_started").pipe(
            Effect.annotateLogs({ runId: trigger.success.runId }),
          );
      } else {
        legacyDownload = { status: "failed", message: trigger.failure.message };
        // The run is forgotten, so the next hourly tick tries again.
        yield* Effect.logError("schedule_run_failed").pipe(
          Effect.annotateLogs({ message: trigger.failure.message }),
        );
      }
    }

    // Fail calculation runs whose Workflow stopped without reporting back.
    const sweep = yield* failStoppedRuns(deps.runWorkflowFor(env), now).pipe(
      Effect.provide(deps.calculationsFor(env)),
      Effect.result,
    );
    if (sweep._tag === "Success" && sweep.success > 0) {
      yield* Effect.logInfo("calculation_runs_failed_as_stopped").pipe(
        Effect.annotateLogs({ count: sweep.success }),
      );
    } else if (sweep._tag === "Failure") {
      yield* Effect.logError("calculation_run_sweep_failed").pipe(
        Effect.annotateLogs({ message: sweep.failure.message }),
      );
    }

    // Start calculations whose cron has fired since their last scheduled run.
    const calculations = yield* triggerScheduledCalculations(
      now,
      deps.runWorkflowFor(env),
    ).pipe(Effect.provide(deps.calculationsFor(env)), Effect.result);
    if (calculations._tag === "Success") {
      for (const run of calculations.success) {
        if ("error" in run)
          yield* Effect.logError("calculation_schedule_failed").pipe(
            Effect.annotateLogs({ ...run }),
          );
        else
          yield* Effect.logInfo("calculation_run_scheduled").pipe(
            Effect.annotateLogs({ ...run }),
          );
      }
    } else {
      yield* Effect.logError("calculation_schedule_failed").pipe(
        Effect.annotateLogs({ message: calculations.failure.message }),
      );
    }

    // Start the durable dispatch Workflow only when WORKFLOW_DISPATCH is "on";
    // it dispatches the due assignments in batches.
    const dispatch = yield* Effect.tryPromise(() =>
      startScheduledWorkflowTick(
        env,
        now,
        deps.dispatchPlatformFor?.(env) ?? env.WORKFLOW_DISPATCHES,
      ),
    ).pipe(Effect.result);
    let workflowTick: ScheduledHandlerOutcome["workflowTick"];
    if (dispatch._tag === "Success") {
      workflowTick = dispatch.success;
      if (dispatch.success.status === "started")
        yield* Effect.logInfo("workflow_dispatch_started").pipe(
          Effect.annotateLogs({ id: dispatch.success.id }),
        );
    } else {
      const message = messageOf(dispatch.failure.cause);
      workflowTick = { status: "failed", message };
      // Nothing claimed is lost: the next tick dispatches what is still due.
      yield* Effect.logError("workflow_dispatch_failed").pipe(
        Effect.annotateLogs({ message }),
      );
    }

    if (now.getUTCHours() === PROCESSING_SWEEP_HOUR) {
      const controlPlane =
        deps.controlPlaneFor?.(env) ??
        D1MarketDataControlPlaneLive(env.MARKET_DATA_DB);
      yield* scheduleProcessing(env.PROCESSING_QUEUE, now).pipe(
        Effect.provide(controlPlane),
      );
    }

    return {
      downloadOwner: workflowsOwnDownloads ? "workflows" : "legacy",
      legacyDownload,
      workflowTick,
    } satisfies ScheduledHandlerOutcome;
  }).pipe(Effect.provide(WorkerLoggerLive), Effect.runPromise);
