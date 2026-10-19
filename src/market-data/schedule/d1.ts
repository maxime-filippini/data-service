import { Effect, Layer } from "effect";

import {
  type DownloadSchedule,
  ScheduleError,
  type ScheduleRun,
  type ScheduleRunStatus,
  ScheduleStore,
  type ScheduleTrigger,
} from "$/market-data/schedule";

interface ScheduleRow {
  readonly hour_utc: number;
  readonly paused: number;
  readonly updated_at: string;
}

interface RunRow {
  readonly run_id: string;
  readonly trigger: ScheduleTrigger;
  readonly run_date: string;
  readonly snapshot_to: string;
  readonly status: ScheduleRunStatus;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly queued_count: number | null;
  readonly skipped_count: number | null;
  readonly error: string | null;
}

const fromScheduleRow = (row: ScheduleRow): DownloadSchedule => ({
  hourUtc: row.hour_utc,
  paused: row.paused === 1,
  updatedAt: row.updated_at,
});

const fromRunRow = (row: RunRow): ScheduleRun => ({
  runId: row.run_id,
  trigger: row.trigger,
  runDate: row.run_date,
  snapshotTo: row.snapshot_to,
  status: row.status,
  createdAt: row.created_at,
  completedAt: row.completed_at,
  queuedCount: row.queued_count,
  skippedCount: row.skipped_count,
  error: row.error,
});

const query = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () => new ScheduleError({ kind: "database", message: "Could not access the download schedule" }),
  });

const requireRow = <A>(row: A | null) =>
  row === null
    ? Effect.fail(new ScheduleError({ kind: "database", message: "The download schedule is missing" }))
    : Effect.succeed(row);

export const D1ScheduleStoreLive = (db: D1Database): Layer.Layer<ScheduleStore> =>
  Layer.succeed(
    ScheduleStore,
    ScheduleStore.of({
      get: () =>
        query(() => db.prepare(`SELECT * FROM download_schedule WHERE id = 1`).first<ScheduleRow>()).pipe(
          Effect.flatMap(requireRow),
          Effect.map(fromScheduleRow),
        ),

      update: (patch, now) =>
        query(() =>
          db
            .prepare(
              `UPDATE download_schedule
               SET hour_utc = coalesce(?1, hour_utc), paused = coalesce(?2, paused), updated_at = ?3
               WHERE id = 1
               RETURNING *`,
            )
            .bind(patch.hourUtc ?? null, patch.paused === undefined ? null : Number(patch.paused), now)
            .first<ScheduleRow>(),
        ).pipe(Effect.flatMap(requireRow), Effect.map(fromScheduleRow)),

      lastScheduledRunDate: () =>
        query(() =>
          db
            .prepare(`SELECT max(run_date) AS run_date FROM schedule_runs WHERE trigger = 'schedule'`)
            .first<{ run_date: string | null }>(),
        ).pipe(Effect.map((row) => row?.run_date ?? null)),

      startRun: (run) =>
        query(() =>
          db
            .prepare(
              `INSERT INTO schedule_runs (run_id, trigger, run_date, snapshot_to, status, created_at)
               VALUES (?, ?, ?, ?, 'running', ?)
               ON CONFLICT DO NOTHING
               RETURNING run_id`,
            )
            .bind(run.runId, run.trigger, run.runDate, run.snapshotTo, run.createdAt)
            .first<{ run_id: string }>(),
        ).pipe(Effect.map((row) => row !== null)),

      removeRun: (runId) =>
        query(() => db.prepare(`DELETE FROM schedule_runs WHERE run_id = ?`).bind(runId).run()).pipe(Effect.asVoid),

      completeRun: (runId, counts, at) =>
        query(() =>
          db
            .prepare(
              `UPDATE schedule_runs
               SET status = 'completed', completed_at = ?, queued_count = ?, skipped_count = ?, error = NULL
               WHERE run_id = ?`,
            )
            .bind(at, counts.queued, counts.skipped, runId)
            .run(),
        ).pipe(Effect.asVoid),

      failRun: (runId, error, at) =>
        query(() =>
          db
            .prepare(`UPDATE schedule_runs SET status = 'failed', completed_at = ?, error = ? WHERE run_id = ?`)
            .bind(at, error, runId)
            .run(),
        ).pipe(Effect.asVoid),

      failStaleRuns: (before, at) =>
        query(() =>
          db
            .prepare(
              `UPDATE schedule_runs
               SET status = 'failed', completed_at = ?, error = 'The run stopped without reporting back'
               WHERE status = 'running' AND created_at < ?`,
            )
            .bind(at, before)
            .run(),
        ).pipe(Effect.map((result) => result.meta.changes)),

      listRuns: (limit) =>
        query(() =>
          db
            .prepare(`SELECT * FROM schedule_runs ORDER BY created_at DESC, run_id DESC LIMIT ?`)
            .bind(limit)
            .all<RunRow>(),
        ).pipe(Effect.map((result) => result.results.map(fromRunRow))),
    }),
  );
