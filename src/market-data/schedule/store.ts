import { Context, type Effect } from "effect";

import type {
  DownloadSchedule,
  ScheduleError,
  ScheduleRun,
  StartScheduleRun,
  UpdateSchedule,
} from "./contracts";

/**
 * Injectable persistence interface for daily download settings and dispatch
 * history. Scheduling operations choose when to launch; this interface only
 * records settings/state and enforces one scheduled record per day. Supply
 * `D1ScheduleStoreLive` at the execution edge; Workflows dispatch messages separately.
 */
export class ScheduleStore extends Context.Service<
  ScheduleStore,
  {
    readonly get: () => Effect.Effect<DownloadSchedule, ScheduleError>;
    readonly update: (
      patch: UpdateSchedule,
      now: string,
    ) => Effect.Effect<DownloadSchedule, ScheduleError>;
    /** The day of the latest run started by the cron, if any. */
    readonly lastScheduledRunDate: () => Effect.Effect<
      string | null,
      ScheduleError
    >;
    /** Record a new run. False if the cron already started one for that day. */
    readonly startRun: (
      run: StartScheduleRun,
    ) => Effect.Effect<boolean, ScheduleError>;
    /** Forget a run whose Workflow never started, so the next cron tick retries. */
    readonly removeRun: (runId: string) => Effect.Effect<void, ScheduleError>;
    readonly completeRun: (
      runId: string,
      counts: { readonly queued: number; readonly skipped: number },
      at: string,
    ) => Effect.Effect<void, ScheduleError>;
    readonly failRun: (
      runId: string,
      error: string,
      at: string,
    ) => Effect.Effect<void, ScheduleError>;
    /** Fail runs still `running` that started before `before`. */
    readonly failStaleRuns: (
      before: string,
      at: string,
    ) => Effect.Effect<number, ScheduleError>;
    /** Runs, newest first. */
    readonly listRuns: (
      limit: number,
    ) => Effect.Effect<readonly ScheduleRun[], ScheduleError>;
  }
>()("data-service/ScheduleStore") {}
