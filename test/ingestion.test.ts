import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Layer } from "effect";

import {
  MarketDataError,
  MarketDataSource,
} from "$/market-data";
import {
  MarketDataControlPlane,
  type CompleteIngestionRun,
  type StartIngestionRun,
} from "$/market-data/control-plane";
import {
  ingestDailyMarketData,
  RawMarketDataStore,
  type StoreRawMarketData,
} from "$/market-data/ingestion";
import { canonicalMarketDataKey } from "$/market-data/processing";
import { rawMarketDataKey } from "$/market-data/r2-raw-store";

import { makeEodEntry } from "./support/market-data-mocks";

const unused = () => Effect.die("unused test service method");

test("an ingestion run stores one range-sized raw object and completes", async () => {
  const started: StartIngestionRun[] = [];
  const stored: StoreRawMarketData[] = [];
  const completed: CompleteIngestionRun[] = [];

  const source = MarketDataSource.of({
    provider: "test-provider",
    retrieveDaily: () =>
      Effect.succeed([
        makeEodEntry("2024-01-02"),
        makeEodEntry("2024-01-03"),
      ]),
  });
  const rawStore = RawMarketDataStore.of({
    store: (input) =>
      Effect.sync(() => {
        stored.push(input);
        return {
          key: rawMarketDataKey(input),
          etag: "raw-etag",
          observedRange: { from: "2024-01-02", to: "2024-01-03" },
          rowCount: input.entries.length,
        };
      }),
  });
  const controlPlane = MarketDataControlPlane.of({
    startIngestionRun: (input) =>
      Effect.sync(() => {
        started.push(input);
      }),
    completeIngestionRun: (input) =>
      Effect.sync(() => {
        completed.push(input);
      }),
    failIngestionRun: () => Effect.void,
    createProcessingJob: unused,
    readProcessingJob: unused,
    claimProcessingJob: unused,
    completeProcessingJob: unused,
    failProcessingJob: unused,
  });
  const dependencies = Layer.merge(
    Layer.succeed(MarketDataSource, source),
    Layer.merge(
      Layer.succeed(RawMarketDataStore, rawStore),
      Layer.succeed(MarketDataControlPlane, controlPlane),
    ),
  );

  const result = await ingestDailyMarketData({
    runId: "run-backfill-aapl",
    symbol: "AAPL.US",
    range: { from: "2024-01-01", to: "2024-01-31" },
    createdAt: "2024-02-01T00:00:00.000Z",
  }).pipe(Effect.provide(dependencies), Effect.runPromise);

  assert.equal(result.runId, "run-backfill-aapl");
  assert.deepEqual(started, [
    {
      runId: "run-backfill-aapl",
      provider: "test-provider",
      symbol: "AAPL.US",
      requestedRange: { from: "2024-01-01", to: "2024-01-31" },
      createdAt: "2024-02-01T00:00:00.000Z",
    },
  ]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.entries.length, 2);
  assert.deepEqual(completed[0]?.object, {
    key: "provider=test-provider/symbol=AAPL.US/run=run-backfill-aapl/response.json",
    etag: "raw-etag",
    observedRange: { from: "2024-01-02", to: "2024-01-03" },
    rowCount: 2,
  });
});

test("a failed provider request marks the ingestion run as failed", async () => {
  const failures: Array<{ runId: string; message: string }> = [];
  const source = MarketDataSource.of({
    provider: "test-provider",
    retrieveDaily: () =>
      Effect.fail(
        new MarketDataError({
          kind: "request",
          message: "Provider unavailable",
          symbol: "AAPL.US",
        }),
      ),
  });
  const controlPlane = MarketDataControlPlane.of({
    startIngestionRun: () => Effect.void,
    completeIngestionRun: unused,
    failIngestionRun: (runId, message) =>
      Effect.sync(() => {
        failures.push({ runId, message });
      }),
    createProcessingJob: unused,
    readProcessingJob: unused,
    claimProcessingJob: unused,
    completeProcessingJob: unused,
    failProcessingJob: unused,
  });
  const dependencies = Layer.merge(
    Layer.succeed(MarketDataSource, source),
    Layer.merge(
      Layer.succeed(
        RawMarketDataStore,
        RawMarketDataStore.of({ store: unused }),
      ),
      Layer.succeed(MarketDataControlPlane, controlPlane),
    ),
  );

  await assert.rejects(
    ingestDailyMarketData({
      runId: "run-failed",
      symbol: "AAPL.US",
      range: { from: "2024-01-01", to: "2024-01-01" },
      createdAt: "2024-01-02T00:00:00.000Z",
    }).pipe(Effect.provide(dependencies), Effect.runPromise),
  );

  assert.deepEqual(failures, [
    { runId: "run-failed", message: "Provider unavailable" },
  ]);
});

test("the canonical object key is stable per symbol", () => {
  assert.equal(
    canonicalMarketDataKey("AAPL.US"),
    "dataset=prices_eod/symbol=AAPL.US/data.parquet",
  );
});
