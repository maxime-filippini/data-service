import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { type CronSchedule, isCronError, latestSlot, nextSlot, parseCron } from "$/calculations/cron";
import { D1CalculationsLive } from "$/calculations/d1";
import type { RunWorkflow } from "$/calculations/runs";
import { triggerScheduledCalculations } from "$/calculations/schedule";
import { makeTestDatabase } from "./support/d1";

const cron = (expression: string): CronSchedule => {
  const parsed = parseCron(expression);
  assert.ok(!isCronError(parsed), expression);
  return parsed;
};

const slot = (expression: string, now: string) => latestSlot(cron(expression), new Date(now))?.toISOString() ?? null;

const next = (expression: string, now: string) => nextSlot(cron(expression), new Date(now))?.toISOString() ?? null;

test("the next slot is the first whole hour after now's hour the cron fires in", () => {
  // Later today, not the current hour, whose tick has already happened.
  assert.equal(next("0 6,18 * * *", "2026-10-28T06:30:00Z"), "2026-10-28T18:00:00.000Z");
  assert.equal(next("0 6 * * *", "2026-10-28T05:59:00Z"), "2026-10-28T06:00:00.000Z");
  assert.equal(next("0 6 * * *", "2026-10-28T06:00:00Z"), "2026-10-29T06:00:00.000Z");
  // Weekdays only: Friday evening goes to Monday.
  assert.equal(next("0 7 * * 1-5", "2026-10-30T20:00:00Z"), "2026-11-02T07:00:00.000Z");
  assert.equal(next("0 0 29 2 *", "2026-10-28T00:00:00Z"), "2028-02-29T00:00:00.000Z");
  assert.equal(next("0 0 30 2 *", "2026-10-28T00:00:00Z"), null);
});

test("the latest slot is the most recent whole hour the cron fires in, minutes ignored", () => {
  // 2026-10-20 is a Tuesday.
  assert.equal(slot("0 * * * *", "2026-10-20T10:59:00Z"), "2026-10-20T10:00:00.000Z");
  assert.equal(slot("45 6 * * *", "2026-10-20T06:00:00Z"), "2026-10-20T06:00:00.000Z");
  assert.equal(slot("0 6 * * *", "2026-10-20T05:59:00Z"), "2026-10-19T06:00:00.000Z");
  assert.equal(slot("0 6,18 * * *", "2026-10-20T05:00:00Z"), "2026-10-19T18:00:00.000Z");
  assert.equal(slot("0 6 * * 1-5", "2026-10-25T10:00:00Z"), "2026-10-23T06:00:00.000Z");
  assert.equal(slot("0 8 1 * *", "2026-10-20T10:00:00Z"), "2026-10-01T08:00:00.000Z");
  assert.equal(slot("0 8 1 JAN *", "2026-10-20T10:00:00Z"), "2026-01-01T08:00:00.000Z");
  // Day of month and day of week both set: either matches.
  assert.equal(slot("0 0 1 * MON", "2026-10-20T10:00:00Z"), "2026-10-19T00:00:00.000Z");
  assert.equal(slot("0 0 29 2 *", "2026-10-20T10:00:00Z"), "2024-02-29T00:00:00.000Z");
  assert.equal(slot("0 0 30 2 *", "2026-10-20T10:00:00Z"), null);
});

const CREATED = "2026-10-01T00:00:00.000Z";

const setup = () => {
  const { sqlite, db } = makeTestDatabase();
  const add = (name: string, schedule: string, options: { enabled?: boolean; createdAt?: string } = {}) => {
    const id = crypto.randomUUID();
    const createdAt = options.createdAt ?? CREATED;
    sqlite
      .prepare(`INSERT INTO calculations (calculation_id, name, type, params_json, cron, enabled, created_at, updated_at)
                VALUES (?, ?, 'market_breadth', '{}', ?, ?, ?, ?)`)
      .run(id, name, schedule, Number(options.enabled ?? true), createdAt, createdAt);
    return id;
  };

  const created: string[] = [];
  const failing = new Set<string>();
  const workflow: RunWorkflow = {
    create: async (options) => {
      const runId = options!.id!;
      const { calculation_id } = sqlite
        .prepare(`SELECT calculation_id FROM calculation_runs WHERE run_id = ?`)
        .get(runId) as { calculation_id: string };
      if (failing.has(calculation_id)) throw new Error("Workflows are down");
      created.push(runId);
      return { id: runId } as WorkflowInstance;
    },
    get: async (id) => ({ id, status: async () => ({ status: "running" }) }) as unknown as WorkflowInstance,
  };

  const tick = (now: string) =>
    triggerScheduledCalculations(new Date(now), workflow).pipe(Effect.provide(D1CalculationsLive(db)), Effect.runPromise);
  const runsOf = (id: string) =>
    sqlite
      .prepare(`SELECT trigger, as_of, status, error FROM calculation_runs WHERE calculation_id = ? ORDER BY created_at`)
      .all(id)
      .map((row) => ({ ...row })) as { trigger: string; as_of: string; status: string; error: string | null }[];
  const lastSlot = (id: string) =>
    (sqlite.prepare(`SELECT last_scheduled_slot FROM calculations WHERE calculation_id = ?`).get(id) as {
      last_scheduled_slot: string | null;
    }).last_scheduled_slot;

  return { sqlite, add, tick, runsOf, lastSlot, created, failing };
};

test("a due calculation runs once per slot, as of the previous UTC day", async () => {
  const { add, tick, runsOf, lastSlot } = setup();
  const daily = add("Daily", "0 6 * * *");

  const first = await tick("2026-10-20T06:00:00Z");
  assert.deepEqual(
    first.map((run) => ("status" in run ? [run.calculationId, run.slot, run.status] : run)),
    [[daily, "2026-10-20T06:00:00.000Z", "running"]],
  );
  assert.deepEqual(runsOf(daily), [{ trigger: "schedule", as_of: "2026-10-19", status: "running", error: null }]);
  assert.equal(lastSlot(daily), "2026-10-20T06:00:00.000Z");

  // Later ticks in the same slot do nothing.
  assert.deepEqual(await tick("2026-10-20T07:00:00Z"), []);
  assert.deepEqual(await tick("2026-10-21T05:00:00Z"), []);
  assert.equal(runsOf(daily).length, 1);
});

test("missed slots run once on the next tick", async () => {
  const { add, tick, runsOf, lastSlot, sqlite } = setup();
  const hourly = add("Hourly", "0 * * * *");
  sqlite.prepare(`UPDATE calculations SET last_scheduled_slot = '2026-10-18T00:00:00.000Z'`).run();

  await tick("2026-10-20T09:00:00Z");
  assert.equal(runsOf(hourly).length, 1);
  assert.equal(lastSlot(hourly), "2026-10-20T09:00:00.000Z");
});

test("disabled calculations, ones created after their slot and ones that never fire don't run", async () => {
  const { add, tick, runsOf } = setup();
  const paused = add("Paused", "0 * * * *", { enabled: false });
  const fresh = add("Fresh", "0 6 * * *", { createdAt: "2026-10-20T06:30:00.000Z" });
  const never = add("Never", "0 0 30 2 *");

  assert.deepEqual(await tick("2026-10-20T07:00:00Z"), []);
  for (const id of [paused, fresh, never]) assert.deepEqual(runsOf(id), []);

  // The fresh calculation runs from its next slot.
  await tick("2026-10-21T06:00:00Z");
  assert.equal(runsOf(fresh).length, 1);
});

test("a calculation with a run going records a skipped run", async () => {
  const { add, tick, runsOf } = setup();
  const hourly = add("Hourly", "0 * * * *");
  await tick("2026-10-20T06:00:00Z");
  const second = await tick("2026-10-20T07:00:00Z");
  assert.equal(second.length, 1);
  assert.equal("status" in second[0]! && second[0].status, "skipped");
  assert.deepEqual(
    runsOf(hourly).map((run) => run.status),
    ["running", "skipped"],
  );
});

test("one calculation failing to start doesn't stop the others, and its slot isn't retried", async () => {
  const { add, tick, runsOf, failing, created } = setup();
  const broken = add("Broken", "0 6 * * *");
  const fine = add("Fine", "0 6 * * *");
  failing.add(broken);

  const results = await tick("2026-10-20T06:00:00Z");
  assert.deepEqual(
    results.map((run) => [run.calculationId, "error" in run ? run.error : run.status]).sort(),
    [
      [broken, "Could not start the run: Workflows are down"],
      [fine, "running"],
    ].sort(),
  );
  assert.equal(runsOf(broken)[0]!.status, "failed");
  assert.equal(created.length, 1);

  failing.clear();
  assert.deepEqual(await tick("2026-10-20T07:00:00Z"), []);
});
