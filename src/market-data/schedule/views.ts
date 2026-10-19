// Plain types shared with the dashboard, so this file must not import anything.

/** The single daily download schedule. */
export interface DownloadSchedule {
  /** UTC hour (0–23) after which the day's run starts. */
  readonly hourUtc: number;
  readonly paused: boolean;
  readonly updatedAt: string;
}

export type ScheduleTrigger = "schedule" | "manual";
export type ScheduleRunStatus = "running" | "completed" | "failed";

/** One run of the schedule, which queues a download for every enabled symbol. */
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

export interface ScheduleView extends DownloadSchedule {
  /** When the next scheduled run should start, or null while paused. */
  readonly nextRunAt: string | null;
}
