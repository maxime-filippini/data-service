import { Effect } from "effect";

import {
  addUtcDays,
  atUtcHour,
  HOUR_MS,
  nextUtcHour,
  previousDay,
  utcDay,
} from "$/datetime";

import {
  ScheduleError,
  type DownloadSchedule,
  type ScheduleView,
} from "./contracts";
import { ScheduleStore } from "./store";

/** A run still `running` after this never reported back (it only queues messages). */
export const STALE_RUN_MS = HOUR_MS;

/**
 * Durable payload for a download-dispatch Workflow. `runId` links to schedule
 * history and the instance ID; `snapshotTo` freezes the upper date bound while
 * the Workflow loads the enabled-symbol selection in its first step.
 */
export interface ScheduledDownloadParams {
  readonly runId: string;
  readonly snapshotTo: string;
}

/**
 * Workflow-binding subset used by download scheduling to create an instance
 * and reconcile an ambiguous launch response. Tests supply this same interface
 * without needing a Cloudflare runtime.
 */
export type ScheduleWorkflow = Pick<
  Workflow<ScheduledDownloadParams>,
  "create" | "get"
>;

/** Whether the cron should start today's run now. Runs late if the hour was missed. */
export const isDue = (
  schedule: DownloadSchedule,
  lastScheduledRunDate: string | null,
  now: Date,
) =>
  !schedule.paused &&
  now.getUTCHours() >= schedule.hourUtc &&
  lastScheduledRunDate !== utcDay(now);

/** When the cron will next start a run. The cron fires at the top of every hour. */
export const nextRunAt = (
  schedule: DownloadSchedule,
  lastScheduledRunDate: string | null,
  now: Date,
) => {
  if (schedule.paused) return null;
  const today = utcDay(now);
  if (lastScheduledRunDate === today)
    return atUtcHour(addUtcDays(now, 1), schedule.hourUtc);
  if (now.getUTCHours() < schedule.hourUtc)
    return atUtcHour(now, schedule.hourUtc);
  // Today's hour has passed without a run, so the next tick catches up.
  return nextUtcHour(now);
};

export const scheduleView = Effect.fn("Schedule.view")(function* (now: Date) {
  const store = yield* ScheduleStore;
  const schedule = yield* store.get();
  const last = yield* store.lastScheduledRunDate();
  return {
    ...schedule,
    nextRunAt: nextRunAt(schedule, last, now)?.toISOString() ?? null,
  } satisfies ScheduleView;
});

/**
 * Start the run's Workflow instance. If creating it fails but the instance
 * exists (the create went through, or an earlier attempt did), it has started.
 */
const startWorkflow = (
  workflow: ScheduleWorkflow,
  params: ScheduledDownloadParams,
) =>
  Effect.tryPromise({
    try: async () => {
      try {
        await workflow.create({ id: params.runId, params });
      } catch (cause) {
        const existing = await workflow
          .get(params.runId)
          .catch(() => undefined);
        if (existing === undefined) throw cause;
      }
    },
    catch: (cause) =>
      new ScheduleError({
        kind: "workflow",
        message: `Could not start the download workflow: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

/**
 * Called by the hourly cron. Fails runs that never reported back, then starts
 * today's run once the schedule's hour has passed, unless the schedule is
 * paused or today's run already started.
 */
export const triggerScheduledRun = Effect.fn("Schedule.trigger")(function* (
  now: Date,
  workflow: ScheduleWorkflow,
) {
  const store = yield* ScheduleStore;
  yield* store.failStaleRuns(
    new Date(now.getTime() - STALE_RUN_MS).toISOString(),
    now.toISOString(),
  );
  const schedule = yield* store.get();
  if (!isDue(schedule, yield* store.lastScheduledRunDate(), now))
    return { status: "not_due" } as const;

  const runDate = utcDay(now);
  const params = { runId: `schedule-${runDate}`, snapshotTo: previousDay(now) };
  const started = yield* store.startRun({
    ...params,
    trigger: "schedule",
    runDate,
    createdAt: now.toISOString(),
  });
  if (!started) return { status: "already_ran" } as const;

  yield* startWorkflow(workflow, params).pipe(
    Effect.tapError(() => store.removeRun(params.runId)),
  );
  return { status: "started", runId: params.runId } as const;
});

/** Run the schedule now, on top of the daily run. */
export const startManualRun = Effect.fn("Schedule.startManual")(function* (
  now: Date,
  workflow: ScheduleWorkflow,
) {
  const store = yield* ScheduleStore;
  const runDate = utcDay(now);
  const params = {
    runId: `manual-${runDate}-${crypto.randomUUID().slice(0, 8)}`,
    snapshotTo: previousDay(now),
  };
  yield* store.startRun({
    ...params,
    trigger: "manual",
    runDate,
    createdAt: now.toISOString(),
  });
  yield* startWorkflow(workflow, params).pipe(
    Effect.tapError((error) =>
      store.failRun(params.runId, error.message, new Date().toISOString()),
    ),
  );
  return params;
});
