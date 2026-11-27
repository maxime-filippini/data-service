import { Effect, type Layer } from "effect";

import { addUtcDays, atUtcHour } from "$/datetime";
import type { Subject } from "$/workflows/contracts";
import type { Steps } from "$/workflows/steps";

import type {
  RunPlatform,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from "./contracts";
import { claimAndLaunch, reconcileRun } from "./operations";
import { type DueAssignment, WorkflowRuns } from "./store";

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
 * Most assignments dispatched or active runs reconciled in one durable
 * batch. The dispatcher continues through all pages in the same execution.
 */
export const DISPATCH_BATCH_SIZE = 100;

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
  /** Default `DISPATCH_BATCH_SIZE`, at most that many per durable batch. */
  readonly batchSize?: number;
}

const dispatchBatch = Effect.fn("WorkflowRuns.dispatchBatch")(function* (
  assignments: readonly DueAssignment[],
  now: Date,
  platform: RunPlatform,
) {
  const dispatched: DispatchedRun[] = [];
  const failures: DispatchFailure[] = [];
  for (const due of assignments) {
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
  return { runs: dispatched, failures };
});

type Runner = <A, E>(program: Effect.Effect<A, E, WorkflowRuns>) => Promise<A>;

export const dispatchScheduledRuns = async (
  now: Date,
  platform: RunPlatform,
  steps: Steps,
  run: Runner,
  options: DispatchOptions = {},
): Promise<Extract<TickReport, { status: "dispatched" }>> => {
  const batchSize = options.batchSize ?? DISPATCH_BATCH_SIZE;
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > DISPATCH_BATCH_SIZE
  )
    throw new RangeError(
      `Dispatch batch size must be an integer between 1 and ${DISPATCH_BATCH_SIZE}`,
    );

  const reconciled = { kept: 0, failed: 0 };
  let afterActive: Pick<WorkflowRunSummary, "createdAt" | "id"> | undefined;
  for (let page = 1; ; page += 1) {
    const active = await steps.do(`select active batch ${page}`, () =>
      run(WorkflowRuns.use((runs) => runs.allActive(batchSize, afterActive))),
    );
    if (active.length === 0) break;
    const counts = await steps.do(`reconcile active batch ${page}`, () =>
      run(
        Effect.gen(function* () {
          const counts = { kept: 0, failed: 0 };
          for (const current of active)
            counts[yield* reconcileRun(platform, current, now)] += 1;
          return counts;
        }),
      ),
    );
    reconciled.kept += counts.kept;
    reconciled.failed += counts.failed;
    const last = active.at(-1)!;
    afterActive = { createdAt: last.createdAt, id: last.id };
    if (active.length < batchSize) break;
  }

  const occurrenceByHour = Array.from({ length: 24 }, (_, hour) =>
    latestOccurrence(hour, now).toISOString(),
  );
  const dispatched: DispatchedRun[] = [];
  const failures: DispatchFailure[] = [];
  let afterDue: DueAssignment | undefined;
  for (let page = 1; ; page += 1) {
    const assignments = await steps.do(`select due batch ${page}`, () =>
      run(
        WorkflowRuns.use((runs) =>
          runs.due(occurrenceByHour, batchSize, afterDue),
        ),
      ),
    );
    if (assignments.length === 0) break;
    const batch = await steps.do(`dispatch due batch ${page}`, () =>
      run(dispatchBatch(assignments, now, platform)),
    );
    dispatched.push(...batch.runs);
    failures.push(...batch.failures);
    afterDue = assignments.at(-1)!;
    if (assignments.length < batchSize) break;
  }

  return { status: "dispatched", reconciled, runs: dispatched, failures };
};

/** What the tick selects from the Worker's bindings. */
export interface DispatchDependencies {
  readonly workflowRunsFor: (
    env: CloudflareBindings,
  ) => Layer.Layer<WorkflowRuns, never, never>;
  readonly runPlatformFor: (env: CloudflareBindings) => RunPlatform;
}

/**
 * Whether the hourly tick dispatches workflows: enabled when `WORKFLOW_DISPATCH`
 * is `on`. Set it to `off` in `wrangler.jsonc` to pause all scheduled dispatch
 * without editing individual workflow definitions.
 */
export const workflowDispatchEnabled = (
  env: Pick<CloudflareBindings, "WORKFLOW_DISPATCH">,
) => String(env.WORKFLOW_DISPATCH) === "on";

/**
 * The dispatch Workflow's body, gated by `WORKFLOW_DISPATCH`, with the
 * trigger's scheduled time and durable steps. Tests and the fixture command
 * call the same body with a controlled clock and local steps.
 */
export const scheduledWorkflowTick = (
  dependencies: DispatchDependencies,
  env: CloudflareBindings,
  now: Date,
  steps: Steps,
  options: DispatchOptions = {},
): Promise<TickReport> =>
  workflowDispatchEnabled(env)
    ? dispatchScheduledRuns(
        now,
        dependencies.runPlatformFor(env),
        steps,
        (program) =>
          program.pipe(
            Effect.provide(dependencies.workflowRunsFor(env)),
            Effect.runPromise,
          ),
        options,
      )
    : Promise.resolve({ status: "disabled" });

export interface WorkflowDispatchParams {
  readonly scheduledTime: string;
}

/** The Workflow binding the hourly tick starts its dispatch instance on. */
export interface DispatchPlatform {
  readonly create: (options: {
    readonly id: string;
    readonly params: WorkflowDispatchParams;
  }) => Promise<unknown>;
  readonly get: (id: string) => Promise<{
    readonly status: () => Promise<unknown>;
  }>;
}

export const startScheduledWorkflowTick = async (
  env: Pick<CloudflareBindings, "WORKFLOW_DISPATCH">,
  now: Date,
  platform: DispatchPlatform,
) => {
  if (!workflowDispatchEnabled(env)) return { status: "disabled" } as const;
  const id = `dispatch-${now.toISOString().slice(0, 13).replace("T", "-")}`;
  try {
    await platform.create({
      id,
      params: { scheduledTime: now.toISOString() },
    });
    return { status: "started", id } as const;
  } catch (error) {
    try {
      const instance = await platform.get(id);
      await instance.status();
    } catch {
      throw error;
    }
    return { status: "existing", id } as const;
  }
};
