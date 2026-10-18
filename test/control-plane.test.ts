import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";

import { MarketDataControlPlane } from "$/market-data/control-plane";
import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import { makeTestDatabase } from "./support/d1";

const setup = () => {
  const { sqlite, db } = makeTestDatabase();
  const controlPlane = Effect.runSync(
    MarketDataControlPlane.pipe(Effect.provide(D1MarketDataControlPlaneLive(db))),
  );
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  /** Record a completed run directly. */
  const addRun = (runId: string, symbol: string, createdAt: string, status = "completed") =>
    sqlite
      .prepare(
        `INSERT INTO ingestion_runs (run_id, dataset, symbol, provider, requested_from, requested_to,
           status, created_at, completed_at, object_key, object_etag, row_count)
         VALUES (?, 'prices_eod', ?, 'eodhd', '2016-01-01', '2026-10-05', ?, ?, ?, ?, 'etag', 10)`,
      )
      .run(runId, symbol, status, createdAt, createdAt, `raw/${runId}.json`);

  const jobs = () =>
    sqlite
      .prepare("SELECT job_id, symbol, run_id, status, error FROM processing_jobs ORDER BY symbol, created_at")
      .all() as { job_id: string; symbol: string; run_id: string; status: string; error: string | null }[];

  return { sqlite, controlPlane, run, addRun, jobs };
};

test("an ingestion run moves from fetching to completed with its raw object", async () => {
  const { sqlite, controlPlane, run } = setup();
  await run(
    controlPlane.startIngestionRun({
      runId: "r1",
      dataset: "prices_eod",
      symbol: "AAPL.US",
      provider: "eodhd",
      requestedRange: { from: "2024-01-01", to: "2024-01-31" },
      createdAt: "2026-10-06T02:00:00Z",
      staleBefore: "2026-10-06T01:30:00Z",
    }),
  );
  await run(
    controlPlane.completeIngestionRun({
      runId: "r1",
      object: { key: "k", etag: "e", rowCount: 2, observedRange: { from: "2024-01-02", to: "2024-01-03" } },
      completedAt: "2026-10-06T02:00:01Z",
    }),
  );
  // A late failure report cannot overwrite a completed run.
  await run(controlPlane.failIngestionRun("r1", "late", "2026-10-06T02:00:02Z"));

  assert.deepEqual(
    { ...sqlite.prepare("SELECT status, object_key, row_count, observed_to, error FROM ingestion_runs").get() },
    { status: "completed", object_key: "k", row_count: 2, observed_to: "2024-01-03", error: null },
  );
});

test("jobs are created only for the latest unprocessed run, one active job per symbol", async () => {
  const { controlPlane, run, addRun, jobs, sqlite } = setup();
  addRun("aapl-old", "AAPL.US", "2026-10-04");
  addRun("aapl-new", "AAPL.US", "2026-10-05");
  addRun("aapl-failed-download", "AAPL.US", "2026-10-06", "failed");
  addRun("msft", "MSFT.US", "2026-10-05");

  assert.equal(await run(controlPlane.createPendingJobs("2026-10-06T02:00:00Z")), 2);
  assert.deepEqual(
    jobs().map((job) => [job.symbol, job.run_id, job.status]),
    [["AAPL.US", "aapl-new", "queued"], ["MSFT.US", "msft", "queued"]],
  );

  // Nothing new while jobs are active, and an active job blocks a newer run.
  addRun("aapl-newest", "AAPL.US", "2026-10-07");
  assert.equal(await run(controlPlane.createPendingJobs("2026-10-07T02:00:00Z")), 0);

  // A failed job is not retried for the same run...
  sqlite.exec("UPDATE processing_jobs SET status = 'failed' WHERE symbol = 'MSFT.US'");
  sqlite.exec("UPDATE processing_jobs SET status = 'completed' WHERE symbol = 'AAPL.US'");
  assert.equal(await run(controlPlane.createPendingJobs("2026-10-07T03:00:00Z")), 1);
  assert.equal(jobs().at(-2)?.run_id, "aapl-newest");

  // ...but the next download for that symbol gets a new job.
  addRun("msft-next", "MSFT.US", "2026-10-08");
  assert.equal(await run(controlPlane.createPendingJobs("2026-10-08T02:00:00Z")), 1);
  assert.equal(jobs().at(-1)?.run_id, "msft-next");
});

test("claiming returns the manifest once, then complete/fail only apply to claimed jobs", async () => {
  const { controlPlane, run, addRun, jobs } = setup();
  addRun("r1", "AAPL.US", "2026-10-05");
  await run(controlPlane.createPendingJobs("2026-10-06T02:00:00Z"));
  const [jobId] = await run(controlPlane.listQueuedJobIds());

  // Not claimed yet: completion is ignored.
  await run(controlPlane.completeJob(jobId!, "etag", "2026-10-06T02:01:00Z"));
  assert.equal(jobs()[0]?.status, "queued");

  const manifest = await run(controlPlane.claimJob(jobId!, "2026-10-06T02:01:00Z"));
  assert.deepEqual(manifest, {
    jobId,
    dataset: "prices_eod",
    symbol: "AAPL.US",
    outputKey: "dataset=prices_eod/symbol=AAPL.US/data.parquet",
    input: {
      runId: "r1",
      provider: "eodhd",
      requestedRange: { from: "2016-01-01", to: "2026-10-05" },
      key: "raw/r1.json",
      etag: "etag",
      rowCount: 10,
    },
  });
  assert.equal(await run(controlPlane.claimJob(jobId!, "2026-10-06T02:02:00Z")), undefined);

  await run(controlPlane.releaseJob(jobId!));
  assert.equal(jobs()[0]?.status, "queued");
  assert.ok(await run(controlPlane.claimJob(jobId!, "2026-10-06T02:03:00Z")));

  await run(controlPlane.completeJob(jobId!, "out-etag", "2026-10-06T02:04:00Z"));
  await run(controlPlane.failJob(jobId!, "too late", "2026-10-06T02:05:00Z"));
  assert.equal(jobs()[0]?.status, "completed");
});

test("stale processing jobs are failed, freeing the symbol", async () => {
  const { controlPlane, run, addRun, jobs } = setup();
  addRun("r1", "AAPL.US", "2026-10-05");
  await run(controlPlane.createPendingJobs("2026-10-06T02:00:00Z"));
  const [jobId] = await run(controlPlane.listQueuedJobIds());
  await run(controlPlane.claimJob(jobId!, "2026-10-06T02:00:00Z"));

  assert.equal(await run(controlPlane.failStaleJobs("2026-10-06T01:00:00Z", "2026-10-06T03:00:00Z")), 0);
  assert.equal(await run(controlPlane.failStaleJobs("2026-10-07T01:00:00Z", "2026-10-07T02:00:00Z")), 1);
  assert.deepEqual(
    jobs().map((job) => [job.status, job.error]),
    [["failed", "Timed out while processing"]],
  );
});
