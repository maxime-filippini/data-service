import { Schema } from "effect";

import type { ScheduleTrigger } from "./views";
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
