import { Effect } from "effect";

import { type Calculation, Calculations } from "$/calculations";
import { isCronError, latestSlot, parseCron } from "$/calculations/cron";
import { type RunWorkflow, startRun } from "$/calculations/runs";
import { previousDay } from "$/market-data/ingestion-queue";

/**
 * The cron slot a calculation should run for now, or null if it isn't due.
 * It's due when its most recent slot is after the last slot it ran for and
 * after it was created, so a new calculation doesn't run for a past slot.
 */
export const dueSlot = (calculation: Calculation, now: Date): string | null => {
  if (!calculation.enabled) return null;
  const schedule = parseCron(calculation.cron);
  if (isCronError(schedule)) return null;
  const slot = latestSlot(schedule, now)?.toISOString();
  if (slot === undefined) return null;
  if (calculation.lastScheduledSlot !== null && slot <= calculation.lastScheduledSlot) return null;
  return slot > calculation.createdAt ? slot : null;
};

export type ScheduledRun =
  | { readonly calculationId: string; readonly slot: string; readonly runId: string; readonly status: "running" | "skipped" }
  | { readonly calculationId: string; readonly slot: string; readonly error: string };

/**
 * Called by the hourly cron. Starts a run, as of the previous UTC day, of each
 * enabled calculation whose cron has fired since its last scheduled run. The
 * slot is recorded before the run starts, so a slot runs at most once even if
 * the tick fires twice. One calculation failing doesn't stop the others.
 */
export const triggerScheduledCalculations = Effect.fn("Calculations.triggerScheduled")(function* (
  now: Date,
  workflow: RunWorkflow,
) {
  const store = yield* Calculations;
  const asOf = previousDay(now);
  const started: ScheduledRun[] = [];
  for (const calculation of yield* store.list()) {
    const slot = dueSlot(calculation, now);
    if (slot === null) continue;
    const result = yield* Effect.gen(function* () {
      if (!(yield* store.claimSlot(calculation.id, slot))) return null;
      return yield* startRun(calculation.id, { trigger: "schedule", asOf }, now, workflow);
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      started.push({ calculationId: calculation.id, slot, error: result.failure.message });
    } else if (result.success !== null) {
      started.push({ calculationId: calculation.id, slot, ...result.success });
    }
  }
  return started;
});
