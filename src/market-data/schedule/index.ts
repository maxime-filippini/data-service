import { Context, Effect, Schema } from "effect";

import { type IngestionMessage, previousDay } from "$/market-data/ingestion-queue";
import type { Dataset } from "$/market-data/schemas";
import { SymbolRegistry, type TrackedSymbol } from "$/market-data/symbol-registry";
import type { DownloadSchedule, ScheduleRun, ScheduleTrigger, ScheduleView } from "./views";

export type * from "./views";

export const UpdateScheduleSchema = Schema.Struct({
  hourUtc: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 }))),
  paused: Schema.optionalKey(Schema.Boolean),
});
export type UpdateSchedule = typeof UpdateScheduleSchema.Type;

export class ScheduleError extends Schema.TaggedError<ScheduleError>()("ScheduleError", {
  kind: Schema.Literals(["database", "workflow"]),
  message: Schema.String,
}) {}

export interface StartScheduleRun {
  readonly runId: string;
  readonly trigger: ScheduleTrigger;
  readonly runDate: string;
  readonly snapshotTo: string;
  readonly createdAt: string;
}

/** The schedule's settings and run history. */
export class ScheduleStore extends Context.Service<
  ScheduleStore,
  {
    readonly get: () => Effect.Effect<DownloadSchedule, ScheduleError>;
    readonly update: (patch: UpdateSchedule, now: string) => Effect.Effect<DownloadSchedule, ScheduleError>;
    /** The day of the latest run started by the cron, if any. */
    readonly lastScheduledRunDate: () => Effect.Effect<string | null, ScheduleError>;
    /** Record a new run. False if the cron already started one for that day. */
    readonly startRun: (run: StartScheduleRun) => Effect.Effect<boolean, ScheduleError>;
    /** Forget a run whose Workflow never started, so the next cron tick retries. */
    readonly removeRun: (runId: string) => Effect.Effect<void, ScheduleError>;
    readonly completeRun: (
      runId: string,
      counts: { readonly queued: number; readonly skipped: number },
      at: string,
    ) => Effect.Effect<void, ScheduleError>;
    readonly failRun: (runId: string, error: string, at: string) => Effect.Effect<void, ScheduleError>;
    /** Fail runs still `running` that started before `before`. */
    readonly failStaleRuns: (before: string, at: string) => Effect.Effect<number, ScheduleError>;
    /** Runs, newest first. */
    readonly listRuns: (limit: number) => Effect.Effect<readonly ScheduleRun[], ScheduleError>;
  }
>()("data-service/ScheduleStore") {}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const utcDay = (date: Date) => date.toISOString().slice(0, 10);
const atHour = (day: string, hour: number) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);

/** Whether the cron should start today's run now. Runs late if the hour was missed. */
export const isDue = (schedule: DownloadSchedule, lastScheduledRunDate: string | null, now: Date) =>
  !schedule.paused && now.getUTCHours() >= schedule.hourUtc && lastScheduledRunDate !== utcDay(now);

/** When the cron will next start a run. The cron fires at the top of every hour. */
export const nextRunAt = (schedule: DownloadSchedule, lastScheduledRunDate: string | null, now: Date) => {
  if (schedule.paused) return null;
  const today = utcDay(now);
  if (lastScheduledRunDate === today) return atHour(utcDay(new Date(now.getTime() + DAY_MS)), schedule.hourUtc);
  if (now.getUTCHours() < schedule.hourUtc) return atHour(today, schedule.hourUtc);
  // Today's hour has passed without a run, so the next tick catches up.
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
};

export const scheduleView = Effect.fn("Schedule.view")(function* (now: Date) {
  const store = yield* ScheduleStore;
  const schedule = yield* store.get();
  const last = yield* store.lastScheduledRunDate();
  return { ...schedule, nextRunAt: nextRunAt(schedule, last, now)?.toISOString() ?? null } satisfies ScheduleView;
});

/** What a run sends to the Workflow. */
export interface ScheduledDownloadParams {
  readonly runId: string;
  readonly snapshotTo: string;
}

export type ScheduleWorkflow = Pick<Workflow<ScheduledDownloadParams>, "create" | "get">;

/**
 * Start the run's Workflow instance. If creating it fails but the instance
 * exists (the create went through, or an earlier attempt did), it has started.
 */
const startWorkflow = (workflow: ScheduleWorkflow, params: ScheduledDownloadParams) =>
  Effect.tryPromise({
    try: async () => {
      try {
        await workflow.create({ id: params.runId, params });
      } catch (cause) {
        const existing = await workflow.get(params.runId).catch(() => undefined);
        if (existing === undefined) throw cause;
      }
    },
    catch: (cause) =>
      new ScheduleError({
        kind: "workflow",
        message: `Could not start the download workflow: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

/** A run still `running` after this never reported back (it only queues messages). */
export const STALE_RUN_MS = HOUR_MS;

/**
 * Called by the hourly cron. Fails runs that never reported back, then starts
 * today's run once the schedule's hour has passed, unless the schedule is
 * paused or today's run already started.
 */
export const triggerScheduledRun = Effect.fn("Schedule.trigger")(function* (now: Date, workflow: ScheduleWorkflow) {
  const store = yield* ScheduleStore;
  yield* store.failStaleRuns(new Date(now.getTime() - STALE_RUN_MS).toISOString(), now.toISOString());
  const schedule = yield* store.get();
  if (!isDue(schedule, yield* store.lastScheduledRunDate(), now)) return { status: "not_due" } as const;

  const runDate = utcDay(now);
  const params = { runId: `schedule-${runDate}`, snapshotTo: previousDay(now) };
  const started = yield* store.startRun({ ...params, trigger: "schedule", runDate, createdAt: now.toISOString() });
  if (!started) return { status: "already_ran" } as const;

  yield* startWorkflow(workflow, params).pipe(Effect.tapError(() => store.removeRun(params.runId)));
  return { status: "started", runId: params.runId } as const;
});

/** Run the schedule now, on top of the daily run. */
export const startManualRun = Effect.fn("Schedule.startManual")(function* (now: Date, workflow: ScheduleWorkflow) {
  const store = yield* ScheduleStore;
  const runDate = utcDay(now);
  const params = { runId: `manual-${runDate}-${crypto.randomUUID().slice(0, 8)}`, snapshotTo: previousDay(now) };
  yield* store.startRun({ ...params, trigger: "manual", runDate, createdAt: now.toISOString() });
  yield* startWorkflow(workflow, params).pipe(
    Effect.tapError((error) => store.failRun(params.runId, error.message, new Date().toISOString())),
  );
  return params;
});

const QUEUE_BATCH_SIZE = 100;

/** Enabled symbols whose history has started by `snapshotTo`, in queue-sized batches. */
export const scheduledBatches = (symbols: readonly TrackedSymbol[], snapshotTo: string) => {
  const due = symbols.filter((symbol) => symbol.enabled && symbol.backfillStartDate <= snapshotTo);
  const batches: { dataset: Dataset; symbol: string }[][] = [];
  for (let index = 0; index < due.length; index += QUEUE_BATCH_SIZE) {
    batches.push(due.slice(index, index + QUEUE_BATCH_SIZE).map(({ dataset, symbol }) => ({ dataset, symbol })));
  }
  return { batches, skipped: symbols.filter((symbol) => symbol.enabled).length - due.length };
};

/** The durable step runner a Workflow provides. Each named step runs once. */
export interface Steps {
  readonly do: <T>(name: string, run: () => Promise<T>) => Promise<T>;
}

/**
 * The Workflow's body: list the enabled symbols, queue them in batches, then
 * record the outcome. A failure is recorded before the Workflow gives up.
 */
export const runScheduledDownload = async (
  params: ScheduledDownloadParams,
  steps: Steps,
  dependencies: {
    readonly run: <A, E>(program: Effect.Effect<A, E, SymbolRegistry | ScheduleStore>) => Promise<A>;
    readonly queue: Pick<Queue<IngestionMessage>, "sendBatch">;
  },
) => {
  const { run, queue } = dependencies;
  try {
    const { batches, skipped } = await steps.do("list enabled symbols", () =>
      run(SymbolRegistry.use((registry) => registry.list({ enabled: true }))).then((symbols) =>
        scheduledBatches(symbols, params.snapshotTo),
      ),
    );
    for (const [index, batch] of batches.entries()) {
      await steps.do(`queue batch ${index + 1} of ${batches.length}`, () =>
        queue.sendBatch(batch.map((entry) => ({ body: { ...entry, to: params.snapshotTo } }))).then(() => batch.length),
      );
    }
    const queued = batches.reduce((total, batch) => total + batch.length, 0);
    await steps.do("record completion", () =>
      run(
        ScheduleStore.use((store) =>
          store.completeRun(params.runId, { queued, skipped }, new Date().toISOString()),
        ),
      ),
    );
    return { queued, skipped };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await steps.do("record failure", () =>
      run(ScheduleStore.use((store) => store.failRun(params.runId, message, new Date().toISOString()))),
    );
    throw cause;
  }
};

