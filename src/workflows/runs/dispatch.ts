import { Effect, type Layer } from "effect";

import { addUtcDays, atUtcHour } from "$/datetime";
import type { Subject } from "$/workflows/contracts";

import type { RunPlatform, WorkflowRunStatus } from "./contracts";
import { claimAndLaunch, reconcileRun } from "./operations";
import { WorkflowRuns } from "./store";

/**
 * Scheduled dispatch: the hourly tick runs each enabled assignment once per
 * daily occurrence of its definition's UTC hour, through the same claim and
 * launch path as manual runs.
 *
 * - The occurrence is the latest one due: today at the hour once it has
 *   passed, otherwise yesterday's. Missed earlier occurrences are never
 *   replayed, so after downtime only the latest one runs.
 * - The run's processing date is the occurrence's UTC date.
 * - Each assignment claims an occurrence at most once (a unique index), so
 *   repeated or concurrent ticks cannot dispatch it twice. An occurrence due
 *   while the assignment's previous run is still active is recorded as a
 *   `skipped` run.
 * - Disabled definitions, assignments and assets are not dispatched. An
 *   assignment enabled again catches up the latest occurrence if it never
 *   claimed it.
 * - Before dispatching, each tick reconciles active runs, so an uncertain
 *   launch or a stopped instance is resolved without a new submission.
 */

/**
 * Most assignments one tick claims, and most active runs it reconciles,
 * bounding the tick's database and Workflow calls. Assignments left over
 * are dispatched by the next ticks while their occurrence is still the
 * latest.
 */
export const MAX_DISPATCH_PER_TICK = 100;

/** The latest daily occurrence of `hourUtc` at or before `now`. */
export const latestOccurrence = (hourUtc: number, now: Date): Date => {
  const today = atUtcHour(now, hourUtc);
  return today.getTime() <= now.getTime() ? today : addUtcDays(today, -1);
};

/** One assignment occurrence the tick claimed. */
export interface DispatchedRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly subject: Subject;
  readonly scheduledFor: string;
  readonly processingDate: string;
  /** `queued` (launched) or `skipped` (another run was active). */
  readonly status: WorkflowRunStatus;
}

/** An assignment occurrence the tick could not claim, and why. */
export interface DispatchFailure {
  readonly workflowId: string;
  readonly subject: Subject;
  readonly scheduledFor: string;
  readonly error: string;
}

/** What one tick did. */
export type TickReport =
  | { readonly status: "disabled" }
  | {
      readonly status: "dispatched";
      readonly reconciled: { readonly kept: number; readonly failed: number };
      readonly runs: readonly DispatchedRun[];
      readonly failures: readonly DispatchFailure[];
    };

export interface DispatchOptions {
  /** Default `MAX_DISPATCH_PER_TICK`. */
  readonly limit?: number;
}

/**
 * Reconcile active runs, then claim and launch every enabled assignment's
 * latest due occurrence it has not claimed yet.
 */
export const dispatchScheduledRuns = Effect.fn("WorkflowRuns.dispatch")(
  function* (now: Date, platform: RunPlatform, options: DispatchOptions = {}) {
    const limit = options.limit ?? MAX_DISPATCH_PER_TICK;
    const runs = yield* WorkflowRuns;

    const reconciled = { kept: 0, failed: 0 };
    for (const active of yield* runs.allActive(limit))
      reconciled[yield* reconcileRun(platform, active, now)] += 1;

    const occurrenceByHour = Array.from({ length: 24 }, (_, hour) =>
      latestOccurrence(hour, now).toISOString(),
    );
    const dispatched: DispatchedRun[] = [];
    const failures: DispatchFailure[] = [];
    for (const due of yield* runs.due(occurrenceByHour, limit)) {
      const processingDate = due.scheduledFor.slice(0, 10);
      const outcome = yield* Effect.result(
        claimAndLaunch(
          {
            workflowId: due.workflowId,
            subject: due.subject,
            processingDate,
            trigger: "schedule",
            scheduledFor: due.scheduledFor,
          },
          now,
          platform,
        ),
      );
      if (outcome._tag === "Failure")
        // Disabled or removed since it was found due: not dispatched.
        failures.push({ ...due, error: outcome.failure.message });
      else if (outcome.success.claimed)
        dispatched.push({
          ...due,
          runId: outcome.success.run.id,
          processingDate,
          status: outcome.success.run.status,
        });
    }
    return {
      status: "dispatched" as const,
      reconciled,
      runs: dispatched,
      failures,
    };
  },
);

/** What the tick selects from the Worker's bindings. */
export interface DispatchDependencies {
  readonly workflowRunsFor: (
    env: CloudflareBindings,
  ) => Layer.Layer<WorkflowRuns, never, never>;
  readonly runPlatformFor: (env: CloudflareBindings) => RunPlatform;
}

/**
 * Whether the hourly tick dispatches workflows: only when the
 * `WORKFLOW_DISPATCH` var is `on`. It is `off` in every deployed
 * environment while the legacy scheduled download owns automatic downloads.
 */
export const workflowDispatchEnabled = (env: CloudflareBindings) =>
  String(env.WORKFLOW_DISPATCH) === "on";

/**
 * The hourly tick's workflow dispatch, gated by `WORKFLOW_DISPATCH`. The
 * Worker's cron handler calls it with the trigger's scheduled time; tests
 * and the fixture command call it with a controlled clock.
 */
export const scheduledWorkflowTick = (
  dependencies: DispatchDependencies,
  env: CloudflareBindings,
  now: Date,
  options: DispatchOptions = {},
): Promise<TickReport> =>
  workflowDispatchEnabled(env)
    ? dispatchScheduledRuns(
        now,
        dependencies.runPlatformFor(env),
        options,
      ).pipe(
        Effect.provide(dependencies.workflowRunsFor(env)),
        Effect.runPromise,
      )
    : Promise.resolve({ status: "disabled" });
