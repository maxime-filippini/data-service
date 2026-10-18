import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Result } from "effect";

import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import { processJob, scheduleProcessing } from "$/market-data/processing";
import { makeTestDatabase } from "./support/d1";

const setup = (symbols: string[] = ["AAPL.US"]) => {
  const { sqlite, db } = makeTestDatabase();
  const insert = sqlite.prepare(
    `INSERT INTO ingestion_runs (run_id, dataset, symbol, provider, requested_from, requested_to,
       status, created_at, completed_at, object_key, object_etag, row_count)
     VALUES (?, 'prices_eod', ?, 'eodhd', '2016-01-01', '2026-10-05', 'completed', '2026-10-05', '2026-10-05', 'raw', 'etag', 1)`,
  );
  for (const symbol of symbols) insert.run(`run-${symbol}`, symbol);

  const layer = D1MarketDataControlPlaneLive(db);
  const sent: string[] = [];
  const queue = {
    sendBatch: async (messages: Iterable<MessageSendRequest<{ jobId: string }>>) => {
      const batch = [...messages];
      assert.ok(batch.length <= 100);
      sent.push(...batch.map((message) => message.body.jobId));
    },
  } as unknown as Pick<Queue<{ jobId: string }>, "sendBatch">;

  const schedule = (now = new Date("2026-10-06T02:00:00Z")) =>
    scheduleProcessing(queue, now).pipe(Effect.provide(layer), Effect.runPromise);
  const process = (jobId: string, fetch: (request: Request) => Promise<Response>) =>
    processJob(jobId, { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(new Request(input, init)) } as Pick<Fetcher, "fetch">).pipe(
      Effect.provide(layer),
      Effect.result,
      Effect.runPromise,
    );
  const job = (jobId: string) =>
    ({ ...sqlite.prepare("SELECT status, output_etag, error FROM processing_jobs WHERE job_id = ?").get(jobId) }) as {
      status: string;
      output_etag: string | null;
      error: string | null;
    };

  return { sqlite, sent, schedule, process, job };
};

test("the schedule queues new jobs in batches and resends queued jobs every day", async () => {
  const symbols = Array.from({ length: 150 }, (_, index) => `SYM${index}`);
  const { sent, schedule } = setup(symbols);

  await schedule();
  assert.equal(sent.length, 150);
  assert.equal(new Set(sent).size, 150);

  // Unprocessed jobs are sent again; no duplicates are created.
  await schedule(new Date("2026-10-07T02:00:00Z"));
  assert.equal(sent.length, 300);
  assert.equal(new Set(sent).size, 150);
});

test("a processor success records the output ETag; redelivery is skipped", async () => {
  const { sent, schedule, process, job } = setup();
  await schedule();
  const jobId = sent[0]!;
  let calls = 0;

  const result = await process(jobId, async (request) => {
    calls++;
    assert.equal(request.url, "http://processor/jobs");
    const manifest = (await request.json()) as { jobId: string; outputKey: string; input: { key: string } };
    assert.equal(manifest.jobId, jobId);
    assert.equal(manifest.outputKey, "dataset=prices_eod/symbol=AAPL.US/data.parquet");
    assert.equal(manifest.input.key, "raw");
    return Response.json({ outputEtag: "out" });
  });
  assert.deepEqual(result, Result.succeed("completed"));
  assert.deepEqual(job(jobId), { status: "completed", output_etag: "out", error: null });

  assert.deepEqual(await process(jobId, async () => assert.fail("must not run twice")), Result.succeed("skipped"));
  assert.equal(calls, 1);
});

test("a processor error response fails the job with its detail", async () => {
  const { sent, schedule, process, job } = setup();
  await schedule();
  const jobId = sent[0]!;

  const result = await process(jobId, async () =>
    Response.json({ detail: "Raw envelope differs from manifest" }, { status: 500 }),
  );
  assert.deepEqual(result, Result.succeed("failed"));
  assert.equal(job(jobId).status, "failed");
  assert.equal(job(jobId).error, "Processor returned 500: Raw envelope differs from manifest");
});

test("an unreachable processor requeues the job so the message can retry", async () => {
  const { sent, schedule, process, job } = setup();
  await schedule();
  const jobId = sent[0]!;

  const result = await process(jobId, async () => {
    throw new Error("container not ready");
  });
  assert.ok(Result.isFailure(result));
  assert.equal(job(jobId).status, "queued");

  assert.deepEqual(await process(jobId, async () => Response.json({ outputEtag: "out" })), Result.succeed("completed"));
});
