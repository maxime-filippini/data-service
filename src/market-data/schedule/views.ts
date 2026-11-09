// Plain types shared with the dashboard, so this file must not import anything.

/**
 * Persisted settings for the single daily download schedule. The hourly tick
 * launches enabled symbols after `hourUtc`; use `ScheduleView` for a client-facing
 * projection that also computes the next expected launch.
 */
export interface DownloadSchedule {
  /** UTC hour (0–23) after which the day's run starts. */
  readonly hourUtc: number;
  readonly paused: boolean;
  readonly updatedAt: string;
}

/**
 * Whether the dispatch run came from the daily schedule or an extra manual launch.
 */
export type ScheduleTrigger = "schedule" | "manual";

/**
 * State of dispatching symbol downloads. `completed` means messages were
 * queued successfully, not that ingestions or Parquet rebuilds have finished.
 */
export type ScheduleRunStatus = "running" | "completed" | "failed";

/**
 * History entry for one Workflow that dispatches enabled-symbol downloads.
 * Use counts/errors to inspect dispatch; follow ingestion/job views for actual
 * pipeline progress. Manual runs coexist with the daily scheduled run.
 */
export interface ScheduleRun {
  /** Also the Workflow instance ID. */
  readonly runId: string;
  readonly trigger: ScheduleTrigger;
  /** The UTC day the run belongs to. */
  readonly runDate: string;
  /** Downloads run up to this date (the day before `runDate`). */
  readonly snapshotTo: string;
  readonly status: ScheduleRunStatus;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly queuedCount: number | null;
  readonly skippedCount: number | null;
  readonly error: string | null;
}

/**
 * Schedule settings enriched for pages and JSON responses with a calculated
 * next launch time. The derived timestamp is not a persisted setting or a
 * promise that dispatch will finish at that time.
 */
export interface ScheduleView extends DownloadSchedule {
  /** When the next scheduled run should start, or null while paused. */
  readonly nextRunAt: string | null;
}
