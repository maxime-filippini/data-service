import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer } from "effect";

import { requireManagementToken } from "$/auth";
import type { IngestionMessage } from "$/market-data/ingestion-queue";
import {
  type DownloadSchedule,
  isDue,
  nextRunAt,
  runScheduledDownload,
  type ScheduledDownloadParams,
  type ScheduleRun,
  ScheduleStore,
  type ScheduleWorkflow,
  startManualRun,
  type Steps,
  triggerScheduledRun,
} from "$/market-data/schedule";
import { D1ScheduleStoreLive } from "$/market-data/schedule/d1";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { createScheduleRoutes } from "$/routes/schedule";
import { makeTestDatabase } from "./support/d1";

const schedule = (overrides: Partial<DownloadSchedule> = {}): DownloadSchedule => ({
  hourUtc: 6,
  paused: false,
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const at = (iso: string) => new Date(iso);

test("a run is due once the hour has passed, once per day, unless paused", () => {
  assert.equal(isDue(schedule(), null, at("2026-10-19T05:00:00Z")), false);
  assert.equal(isDue(schedule(), null, at("2026-10-19T06:00:00Z")), true);
  assert.equal(isDue(schedule(), "2026-10-18", at("2026-10-19T09:00:00Z")), true, "catches up on a missed hour");
  assert.equal(isDue(schedule(), "2026-10-19", at("2026-10-19T09:00:00Z")), false);
  assert.equal(isDue(schedule({ paused: true }), null, at("2026-10-19T09:00:00Z")), false);
});

test("the next run is today at the hour, tomorrow after today's run, or the next tick when late", () => {
  const next = (s: DownloadSchedule, last: string | null, now: string) => nextRunAt(s, last, at(now))?.toISOString();
  assert.equal(next(schedule(), null, "2026-10-19T05:30:00Z"), "2026-10-19T06:00:00.000Z");
  assert.equal(next(schedule(), "2026-10-19", "2026-10-19T06:10:00Z"), "2026-10-20T06:00:00.000Z");
  assert.equal(next(schedule(), "2026-10-18", "2026-10-19T09:10:00Z"), "2026-10-19T10:00:00.000Z");
  assert.equal(next(schedule({ hourUtc: 23 }), "2026-10-31", "2026-10-31T23:05:00Z"), "2026-11-01T23:00:00.000Z");
  assert.equal(next(schedule({ paused: true }), null, "2026-10-19T05:30:00Z"), undefined);
});

const setup = () => {
  const { sqlite, db } = makeTestDatabase();
  const layer = Layer.mergeAll(D1ScheduleStoreLive(db), D1SymbolRegistryLive(db));
  const run = <A, E>(program: Effect.Effect<A, E, ScheduleStore | Layer.Success<typeof layer>>) =>
    program.pipe(Effect.provide(layer), Effect.runPromise);

  const created: ScheduledDownloadParams[] = [];
  const instances = new Set<string>();
  let failNextCreate: "unavailable" | "after_creating" | null = null;
  const workflow: ScheduleWorkflow = {
    create: async (options) => {
      const id = options!.id!;
      const failure = failNextCreate;
      failNextCreate = null;
      if (failure === "unavailable") throw new Error("Workflows unavailable");
      if (instances.has(id)) throw new Error(`Instance ${id} already exists`);
      instances.add(id);
      created.push(options!.params as ScheduledDownloadParams);
      if (failure === "after_creating") throw new Error("Connection reset");
      return { id } as WorkflowInstance;
    },
    get: async (id) => {
      if (!instances.has(id)) throw new Error("Instance not found");
      return { id } as WorkflowInstance;
    },
  };

  const register = (symbol: string, enabled = 1, backfillStartDate = "2016-01-01") =>
    sqlite
      .prepare(
        `INSERT INTO tracked_symbols VALUES ('prices_eod', ?, 'eodhd', ?, ?, 'now', 'now')`,
      )
      .run(symbol, enabled, backfillStartDate);
  const runs = () => run(ScheduleStore.use((store) => store.listRuns(50)));

  return {
    sqlite,
    db,
    run,
    workflow,
    created,
    register,
    runs,
    failWorkflow: (how: "unavailable" | "after_creating" = "unavailable") => (failNextCreate = how),
  };
};

test("the schedule starts paused at 06:00 UTC and can be changed", async () => {
  const { run } = setup();
  const initial = await run(ScheduleStore.use((store) => store.get()));
  assert.deepEqual({ hourUtc: initial.hourUtc, paused: initial.paused }, { hourUtc: 6, paused: true });

  const updated = await run(ScheduleStore.use((store) => store.update({ paused: false }, "2026-10-19T00:00:00.000Z")));
  assert.deepEqual(updated, { hourUtc: 6, paused: false, updatedAt: "2026-10-19T00:00:00.000Z" });
  const moved = await run(ScheduleStore.use((store) => store.update({ hourUtc: 22 }, "2026-10-19T01:00:00.000Z")));
  assert.equal(moved.hourUtc, 22);
  assert.equal(moved.paused, false);
});

test("the cron starts one run per day once the hour has passed", async () => {
  const { run, workflow, created, runs } = setup();
  const trigger = (iso: string) => run(triggerScheduledRun(at(iso), workflow));

  assert.equal((await trigger("2026-10-19T07:00:00Z")).status, "not_due", "paused");
  await run(ScheduleStore.use((store) => store.update({ paused: false }, "2026-10-19T07:00:00.000Z")));

  assert.equal((await trigger("2026-10-19T05:00:00Z")).status, "not_due");
  assert.deepEqual(await trigger("2026-10-19T07:00:00Z"), { status: "started", runId: "schedule-2026-10-19" });
  assert.equal((await trigger("2026-10-19T08:00:00Z")).status, "not_due");
  assert.deepEqual(created, [{ runId: "schedule-2026-10-19", snapshotTo: "2026-10-18" }]);

  const [only] = await runs();
  assert.equal(only!.trigger, "schedule");
  assert.equal(only!.status, "running");
  assert.equal(only!.runDate, "2026-10-19");

  assert.equal((await trigger("2026-10-20T06:00:00Z")).status, "started");

  // The unique index is the final guard if two ticks race past the date check.
  const again = await run(
    ScheduleStore.use((store) =>
      store.startRun({
        runId: "schedule-2026-10-20-race",
        trigger: "schedule",
        runDate: "2026-10-20",
        snapshotTo: "2026-10-19",
        createdAt: "2026-10-20T06:00:01.000Z",
      }),
    ),
  );
  assert.equal(again, false);
});

test("a run whose Workflow failed to start is retried on the next tick", async () => {
  const { run, workflow, created, runs, failWorkflow } = setup();
  await run(ScheduleStore.use((store) => store.update({ paused: false }, "2026-10-19T00:00:00.000Z")));

  failWorkflow();
  await assert.rejects(run(triggerScheduledRun(at("2026-10-19T06:00:00Z"), workflow)), /Workflows unavailable/u);
  assert.deepEqual(await runs(), []);

  assert.equal((await run(triggerScheduledRun(at("2026-10-19T07:00:00Z"), workflow))).status, "started");
  assert.equal(created.length, 1);
});

test("a Workflow that started despite an error counts as started", async () => {
  const { run, workflow, created, runs, failWorkflow } = setup();
  await run(ScheduleStore.use((store) => store.update({ paused: false }, "2026-10-19T00:00:00.000Z")));

  failWorkflow("after_creating");
  assert.equal((await run(triggerScheduledRun(at("2026-10-19T06:00:00Z"), workflow))).status, "started");
  assert.equal((await runs())[0]?.status, "running");
  assert.equal((await run(triggerScheduledRun(at("2026-10-19T07:00:00Z"), workflow))).status, "not_due");
  assert.equal(created.length, 1);
});

test("the cron fails runs that never reported back", async () => {
  const { run, workflow, runs } = setup();
  await run(startManualRun(at("2026-10-19T05:00:00Z"), workflow));
  await run(startManualRun(at("2026-10-19T06:30:00Z"), workflow));

  await run(triggerScheduledRun(at("2026-10-19T07:00:00Z"), workflow));
  const [recent, old] = await runs();
  assert.equal(recent!.status, "running");
  assert.equal(old!.status, "failed");
  assert.equal(old!.error, "The run stopped without reporting back");
  assert.equal(old!.completedAt, "2026-10-19T07:00:00.000Z");
});

test("manual runs are extra and do not use up the day's scheduled run", async () => {
  const { run, workflow, created, runs, failWorkflow } = setup();
  await run(ScheduleStore.use((store) => store.update({ paused: false }, "2026-10-19T00:00:00.000Z")));

  const manual = await run(startManualRun(at("2026-10-19T05:00:00Z"), workflow));
  assert.match(manual.runId, /^manual-2026-10-19-[0-9a-f]{8}$/u);
  assert.equal(manual.snapshotTo, "2026-10-18");
  assert.equal((await run(triggerScheduledRun(at("2026-10-19T06:00:00Z"), workflow))).status, "started");

  failWorkflow();
  await assert.rejects(run(startManualRun(at("2026-10-19T08:00:00Z"), workflow)));
  const failed = (await runs()).find((r) => r.status === "failed");
  assert.match(failed?.error ?? "", /Workflows unavailable/u);
  assert.equal(created.length, 2);
});

const immediateSteps = () => {
  const names: string[] = [];
  const steps: Steps = {
    do: async (name, body) => {
      names.push(name);
      return body();
    },
  };
  return { steps, names };
};

test("the Workflow queues every enabled symbol in batches of 100 and records the outcome", async () => {
  const { run, register, runs } = setup();
  for (let index = 0; index < 205; index += 1) register(`S${index}.US`);
  register("OFF.US", 0);
  register("LATER.US", 1, "2026-10-19");
  await run(
    ScheduleStore.use((store) =>
      store.startRun({
        runId: "schedule-2026-10-19",
        trigger: "schedule",
        runDate: "2026-10-19",
        snapshotTo: "2026-10-18",
        createdAt: "2026-10-19T06:00:00.000Z",
      }),
    ),
  );

  const sent: IngestionMessage[][] = [];
  const queue = { sendBatch: async (batch: Iterable<MessageSendRequest<IngestionMessage>>) => {
    sent.push([...batch].map((message) => message.body));
  } };
  const { steps, names } = immediateSteps();
  const result = await runScheduledDownload({ runId: "schedule-2026-10-19", snapshotTo: "2026-10-18" }, steps, {
    run,
    queue: queue as unknown as Queue<IngestionMessage>,
  });

  assert.deepEqual(result, { queued: 205, skipped: 1 });
  assert.deepEqual(sent.map((batch) => batch.length), [100, 100, 5]);
  assert.deepEqual(sent[0]![0], { dataset: "prices_eod", symbol: "S0.US", to: "2026-10-18" });
  assert.ok(sent.flat().every((message) => message.symbol !== "OFF.US" && message.symbol !== "LATER.US"));
  assert.deepEqual(names, [
    "list enabled symbols",
    "queue batch 1 of 3",
    "queue batch 2 of 3",
    "queue batch 3 of 3",
    "record completion",
  ]);

  const [recorded] = await runs();
  assert.equal(recorded!.status, "completed");
  assert.equal(recorded!.queuedCount, 205);
  assert.equal(recorded!.skippedCount, 1);
});

test("a failing Workflow records the error before giving up", async () => {
  const { run, register, runs } = setup();
  register("AAPL.US");
  await run(
    ScheduleStore.use((store) =>
      store.startRun({
        runId: "manual-1",
        trigger: "manual",
        runDate: "2026-10-19",
        snapshotTo: "2026-10-18",
        createdAt: "2026-10-19T06:00:00.000Z",
      }),
    ),
  );
  const queue = { sendBatch: async () => Promise.reject(new Error("Queue is full")) };
  const { steps, names } = immediateSteps();

  await assert.rejects(
    runScheduledDownload({ runId: "manual-1", snapshotTo: "2026-10-18" }, steps, {
      run,
      queue: queue as unknown as Queue<IngestionMessage>,
    }),
    /Queue is full/u,
  );
  assert.equal(names.at(-1), "record failure");
  const [recorded] = await runs();
  assert.equal(recorded!.status, "failed");
  assert.equal(recorded!.error, "Queue is full");
});

test("the schedule API shows, changes and runs the schedule", async () => {
  const { db, workflow, created } = setup();
  const app = createScheduleRoutes(
    { storeFor: () => D1ScheduleStoreLive(db), workflowFor: () => workflow },
    requireManagementToken,
  );
  const env = { MANAGEMENT_API_TOKEN: "management" } as CloudflareBindings;
  const request = (path: string, method = "GET", body?: unknown, token = "management") =>
    app.request(
      path,
      {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  for (const [path, method] of [["/", "GET"], ["/", "PATCH"], ["/runs", "GET"], ["/runs", "POST"]] as const) {
    assert.equal((await request(path, method, method === "PATCH" ? {} : undefined, "wrong")).status, 401, path);
  }

  const initial = (await (await request("/")).json()) as Record<string, unknown>;
  assert.equal(initial.paused, true);
  assert.equal(initial.nextRunAt, null);

  const patched = await request("/", "PATCH", { hourUtc: 21, paused: false });
  assert.equal(patched.status, 200);
  const view = (await patched.json()) as Record<string, unknown>;
  assert.equal(view.hourUtc, 21);
  assert.equal(typeof view.nextRunAt, "string");

  for (const body of [{ hourUtc: 24 }, { hourUtc: 1.5 }, { paused: "no" }, { cron: "* * * * *" }]) {
    assert.equal((await request("/", "PATCH", body)).status, 400, JSON.stringify(body));
  }

  const started = await request("/runs", "POST");
  assert.equal(started.status, 202);
  assert.equal(created.length, 1);
  const { runs } = (await (await request("/runs")).json()) as { runs: ScheduleRun[] };
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.trigger, "manual");
  assert.equal((await request("/runs?limit=101")).status, 400);
});
