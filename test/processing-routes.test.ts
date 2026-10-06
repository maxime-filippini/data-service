import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Layer } from "effect";

import {
  MarketDataControlPlane,
  MarketDataControlPlaneError,
  type ProcessingJob,
  type ProcessingJobStatus,
} from "$/market-data/control-plane";
import {
  createProcessingRoutes,
  type ProcessingJobBindings,
} from "$/routes/processing";

const processorToken = "test-processor-token";
const authorization = { Authorization: `Bearer ${processorToken}` };

const request = (
  app: ReturnType<typeof createProcessingRoutes>,
  path: string,
  init: RequestInit = {},
) =>
  app.request(
    path,
    {
      ...init,
      headers: { ...authorization, ...init.headers },
    },
    { PROCESSING_API_TOKEN: processorToken } as ProcessingJobBindings,
  );

const noWork = () =>
  Effect.fail(
    new MarketDataControlPlaneError({
      kind: "no_work",
      message: "No completed ingestion runs are available for processing",
      symbol: "AAPL.US",
    }),
  );

const createApp = (options: { readonly hasWork?: boolean } = {}) => {
  let status: ProcessingJobStatus = "queued";
  let job: ProcessingJob | undefined;
  const claimed: string[] = [];
  const completed: string[] = [];
  const failed: string[] = [];

  const controlPlane = MarketDataControlPlane.of({
    startIngestionRun: () => Effect.void,
    completeIngestionRun: () => Effect.void,
    failIngestionRun: () => Effect.void,
    createProcessingJob: (input) => {
      if (options.hasWork === false) {
        return noWork();
      }

      job = {
        jobId: input.jobId,
        symbol: input.symbol,
        mode: input.mode,
        canonicalKey: input.canonicalKey,
        transformVersion: input.transformVersion,
        status,
        createdAt: input.createdAt,
        runs: [],
      };
      return Effect.succeed(job);
    },
    readProcessingJob: (jobId) =>
      job === undefined || jobId !== job.jobId
        ? Effect.fail(
            new MarketDataControlPlaneError({
              kind: "not_found",
              message: "The processing job does not exist",
              jobId,
            }),
          )
        : Effect.succeed({ ...job, status }),
    claimProcessingJob: (jobId) =>
      Effect.sync(() => {
        assert.equal(jobId, job?.jobId);
        assert.equal(status, "queued");
        claimed.push(jobId);
        status = "processing";
      }),
    completeProcessingJob: (input) =>
      Effect.sync(() => {
        assert.equal(input.jobId, job?.jobId);
        assert.equal(status, "processing");
        completed.push(input.outputEtag);
        status = "completed";
      }),
    failProcessingJob: (jobId) =>
      Effect.sync(() => {
        assert.equal(jobId, job?.jobId);
        failed.push(jobId);
        status = "failed";
      }),
  });

  return {
    app: createProcessingRoutes(() => Layer.succeed(MarketDataControlPlane, controlPlane)),
    claimed,
    completed,
    failed,
  };
};

test("processing-job routes require the processor bearer token", async () => {
  const { app } = createApp();

  const response = await app.request("/", { method: "POST" }, {
    PROCESSING_API_TOKEN: processorToken,
  } as ProcessingJobBindings);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("a processor can create, claim, and complete a frozen job", async () => {
  const { app, claimed, completed } = createApp();
  const create = await request(app, "/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: "AAPL.US",
      mode: "merge",
      transformVersion: "prices-eod-v1",
    }),
  });

  assert.equal(create.status, 201);
  const created = (await create.json()) as ProcessingJob;
  assert.equal(created.symbol, "AAPL.US");
  assert.equal(created.status, "queued");
  assert.equal(created.canonicalKey, "dataset=prices_eod/symbol=AAPL.US/data.parquet");

  const claim = await request(app, `/${created.jobId}/claim`, { method: "POST" });
  assert.equal(claim.status, 200);
  assert.equal((await claim.json() as ProcessingJob).status, "processing");
  assert.deepEqual(claimed, [created.jobId]);

  const complete = await request(app, `/${created.jobId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outputEtag: "processed-etag", completeThrough: "2024-01-31" }),
  });
  assert.equal(complete.status, 200);
  assert.equal((await complete.json() as ProcessingJob).status, "completed");
  assert.deepEqual(completed, ["processed-etag"]);
});

test("a processor can mark a claimed job as failed", async () => {
  const { app, failed } = createApp();
  const create = await request(app, "/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: "AAPL.US",
      mode: "rebuild",
      transformVersion: "prices-eod-v1",
    }),
  });
  const created = (await create.json()) as ProcessingJob;

  await request(app, `/${created.jobId}/claim`, { method: "POST" });
  const failure = await request(app, `/${created.jobId}/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Parquet write failed" }),
  });

  assert.equal(failure.status, 200);
  assert.equal((await failure.json() as ProcessingJob).status, "failed");
  assert.deepEqual(failed, [created.jobId]);
});

test("creating a job without eligible raw runs returns a conflict", async () => {
  const { app } = createApp({ hasWork: false });
  const response = await request(app, "/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: "AAPL.US",
      mode: "merge",
      transformVersion: "prices-eod-v1",
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "No completed ingestion runs are available for processing",
    jobId: null,
    symbol: "AAPL.US",
  });
});
