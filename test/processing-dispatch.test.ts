import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import test from "node:test";
import { Effect, Layer } from "effect";
import { MarketDataControlPlane, type ProcessingJob, type ProcessingJobStatus } from "$/market-data/control-plane";
import { selectedRunsQuery } from "$/market-data/control-plane/d1";
import { executeProcessingMessage, scheduleProcessing } from "$/market-data/processing-dispatch";

function harness(initial: ProcessingJobStatus = "queued") {
  let status = initial;
  const created: string[] = [];
  const job: ProcessingJob = {
    jobId: "job", symbol: "AAPL.US", mode: "merge", canonicalKey: "data.parquet",
    transformVersion: "v1", status, createdAt: "2026-10-06T02:00:00.000Z", runs: [],
  };
  const unused = () => Effect.die("Unexpected control-plane operation");
  const layer = Layer.succeed(MarketDataControlPlane, MarketDataControlPlane.of({
    startIngestionRun: unused, completeIngestionRun: unused, failIngestionRun: unused,
    claimProcessingJob: unused, completeProcessingJob: unused, failProcessingJob: unused,
    readProcessingJob: () => Effect.succeed({ ...job, status }),
    createProcessingJob: (input) => Effect.sync(() => {
      assert.equal(input.transformVersion, "v1");
      assert.equal(input.mode, "rebuild");
      created.push(input.symbol);
      return { ...job, ...input, status: "queued" as const };
    }),
  }));
  return { layer, created, setStatus: (value: ProcessingJobStatus) => { status = value; } };
}

test("delivery awaits durable completion and duplicate delivery skips execution", async () => {
  const state = harness();
  let executions = 0;
  const processor = { fetch: async (request: Request) => {
    assert.equal(request.url, "http://processor/processing-jobs/job/execute");
    assert.equal(request.headers.get("Authorization"), "Bearer secret");
    executions++;
    state.setStatus("completed");
    return Response.json({});
  } } as Pick<Fetcher, "fetch">;
  await executeProcessingMessage({ jobId: "job" }, state.layer, processor, "secret");
  await executeProcessingMessage({ jobId: "job" }, state.layer, processor, "secret");
  assert.equal(executions, 1);
});

test("claimed jobs never execute again and require reconciliation", async () => {
  const state = harness("processing");
  const processor = { fetch: async () => { assert.fail("Must not execute"); } } as Pick<Fetcher, "fetch">;
  await assert.rejects(executeProcessingMessage({ jobId: "job" }, state.layer, processor, "secret"), /already claimed/);
});

test("a successful HTTP response without completion remains retryable", async () => {
  const state = harness();
  const processor = { fetch: async () => new Response(null, { status: 200 }) } as Pick<Fetcher, "fetch">;
  await assert.rejects(executeProcessingMessage({ jobId: "job" }, state.layer, processor, "secret"), /did not complete/);
});

test("transport errors retry; terminal failures and malformed messages do not execute", async () => {
  const state = harness();
  const processor = { fetch: async () => { throw new Error("connection lost"); } } as Pick<Fetcher, "fetch">;
  await assert.rejects(executeProcessingMessage({ jobId: "job" }, state.layer, processor, "secret"), /connection lost/);
  state.setStatus("failed");
  await executeProcessingMessage({ jobId: "job" }, state.layer, processor, "secret");
  await assert.rejects(executeProcessingMessage({ symbol: "AAPL" }, state.layer, processor, "secret"), /Invalid/);
});

test("schedule selects pending symbols, blocks failed inputs, and republishes queued jobs after send failure", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial_market_data_control_plane.sql", import.meta.url), "utf8"));
  const run = sqlite.prepare(`INSERT INTO ingestion_runs
    (run_id, provider, symbol, requested_from, requested_to, status, created_at)
    VALUES (?, 'eodhd', ?, '2026-10-01', '2026-10-06', 'raw_complete', '2026-10-06')`);
  for (const symbol of ["PENDING", "APPLIED", "ACTIVE", "FAILED"]) run.run(symbol, symbol);
  sqlite.prepare(`INSERT INTO ingestion_runs
    (run_id, provider, symbol, requested_from, requested_to, status, created_at)
    VALUES ('old-applied-symbol', 'eodhd', 'APPLIED', '2026-10-01', '2026-10-05', 'raw_complete', '2026-10-05')`).run();
  for (let index = 0; index < 105; index++) {
    const symbol = `BATCH-${String(index).padStart(3, "0")}`;
    run.run(symbol, symbol);
  }
  sqlite.exec(`
    INSERT INTO processing_jobs (job_id, symbol, mode, canonical_key, transform_version, status, created_at) VALUES
      ('queued', 'ACTIVE', 'merge', 'data', 'v1', 'queued', '2026-10-06'),
      ('failed', 'FAILED', 'merge', 'data', 'v1', 'failed', '2026-10-06'),
      ('complete', 'APPLIED', 'merge', 'data', 'v1', 'completed', '2026-10-06');
    INSERT INTO processing_job_runs VALUES ('failed', 'FAILED', 0);
    INSERT INTO canonical_datasets (symbol, object_key) VALUES ('APPLIED', 'data');
    INSERT INTO canonical_run_applications VALUES ('APPLIED', 'APPLIED', 'complete', 1, '2026-10-06');
  `);
  const database = { prepare: (sql: string) => ({ bind: (...values: (string | number)[]) => ({
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
  }) }) } as D1Database;
  const state = harness();
  const created = MarketDataControlPlane.of({
    ...Effect.runSync(MarketDataControlPlane.pipe(Effect.provide(state.layer))),
    createProcessingJob: (input) => Effect.sync(() => {
      state.created.push(input.symbol);
      assert.equal(input.transformVersion, "v1");
      assert.equal(input.mode, "rebuild");
      sqlite.prepare(`INSERT INTO processing_jobs
        (job_id, symbol, mode, canonical_key, transform_version, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?)`).run(input.jobId, input.symbol, input.mode, input.canonicalKey, input.transformVersion, input.createdAt);
      return { ...input, status: "queued" as const, runs: [] };
    }),
  });
  const layer = Layer.succeed(MarketDataControlPlane, created);
  const delivered: string[] = [];
  const queue: Pick<Queue<{ jobId: string }>, "sendBatch"> = {
    sendBatch: async (messages) => {
      const batch = [...messages];
      assert.ok(batch.length <= 100);
      for (const message of batch) delivered.push(message.body.jobId);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: new Date(0) } } };
    },
  };
  try {
    await assert.rejects(scheduleProcessing(database, { sendBatch: async () => { throw new Error("queue unavailable"); } }, layer, "2026-10-06"), /queue unavailable/);
    await scheduleProcessing(database, queue, layer, "2026-10-06");
    assert.equal(state.created.length, 106);
    assert.ok(state.created.includes("PENDING"));
    assert.ok(!state.created.includes("APPLIED"));
    assert.ok(!state.created.includes("ACTIVE"));
    assert.ok(!state.created.includes("FAILED"));
    assert.equal(delivered.length, 107);
    assert.equal(new Set(delivered).size, 107);
    assert.ok(delivered.includes("queued"));
    sqlite.exec(`INSERT INTO processing_jobs
      (job_id, symbol, mode, canonical_key, transform_version, status, created_at)
      VALUES ('recovery', 'FAILED', 'rebuild', 'data', 'v1', 'completed', '2026-10-07')`);
    await scheduleProcessing(database, queue, layer, "2026-10-08");
    assert.equal(state.created.at(-1), "FAILED");
  } finally {
    sqlite.close();
  }
});

test("rebuild selects only the latest successful snapshot by ingestion creation time", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(readFileSync(new URL("../migrations/0001_initial_market_data_control_plane.sql", import.meta.url), "utf8"));
    sqlite.exec(`INSERT INTO ingestion_runs
      (run_id, provider, symbol, requested_from, requested_to, status, created_at, completed_at)
      VALUES
      ('older', 'eodhd', 'AAPL.US', '2000-01-01', '2026-10-04', 'raw_complete', '2026-10-04', '2026-10-06'),
      ('latest', 'eodhd', 'AAPL.US', '2000-01-01', '2026-10-05', 'raw_complete', '2026-10-05', '2026-10-05'),
      ('failed', 'eodhd', 'AAPL.US', '2000-01-01', '2026-10-06', 'failed', '2026-10-06', '2026-10-06');`);
    assert.deepEqual(sqlite.prepare(selectedRunsQuery("rebuild")).all("AAPL.US").map((row) => row.run_id), ["latest"]);
    assert.deepEqual(sqlite.prepare(selectedRunsQuery("rebuild")).all("UNKNOWN"), []);
  } finally {
    sqlite.close();
  }
});
