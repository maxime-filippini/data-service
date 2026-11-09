/**
 * Inputs and expected errors for configuring and recording download dispatch.
 * Scheduling policy lives in `operations.ts`, persistence in `store.ts`, and
 * client-facing projections in `views.ts`.
 */

import { Schema } from "effect";

import type { ScheduleTrigger } from "./views";
export type * from "./views";

/**
 * HTTP patch for the one daily download schedule. Omitted settings are kept;
 * pausing stops automatic launches without disabling symbols or manual runs.
 */
export const UpdateScheduleSchema = Schema.Struct({
  hourUtc: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  ),
  paused: Schema.optionalKey(Schema.Boolean),
});

/**
 * Decoded settings patch accepted by `ScheduleStore.update`, separate from
 * the schedule view's derived next-run timestamp.
 */
export type UpdateSchedule = typeof UpdateScheduleSchema.Type;

/**
 * Expected D1 or Workflow-launch failure in download scheduling. Used by
 * HTTP/cron callers to report failure; individual symbol download failures
 * are recorded later as ingestion runs, outside this schedule outcome.
 */
export class ScheduleError extends Schema.TaggedError<ScheduleError>()(
  "ScheduleError",
  {
    kind: Schema.Literals(["database", "workflow"]),
    message: Schema.String,
  },
) {}

/**
 * Initial record saved before creating a download Workflow. `runDate` is the
 * UTC day of the launch; `snapshotTo` fixes the download cutoff used by its
 * queued messages. Completion means dispatch finished, not that data is rebuilt.
 */
export interface StartScheduleRun {
  readonly runId: string;
  readonly trigger: ScheduleTrigger;
  readonly runDate: string;
  readonly snapshotTo: string;
  readonly createdAt: string;
}
