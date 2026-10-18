import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer } from "effect";

import { MarketDataError, MarketDataSource } from "$/market-data";
import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import { ingestMarketData, RawMarketDataStore, type StoreRawMarketData } from "$/market-data/ingestion";
import { rawMarketDataKey } from "$/market-data/r2-raw-store";
import { makeTestDatabase } from "./support/d1";

const entry = (date: string) => ({ date, open: 1, close: 1, high: 1, low: 1, adjusted_close: 1, volume: 1 });

const setup = (retrieve: () => Effect.Effect<readonly { date: string }[], MarketDataError>) => {
  const { sqlite, db } = makeTestDatabase();
  const stored: StoreRawMarketData[] = [];
  const layer = Layer.mergeAll(
    D1MarketDataControlPlaneLive(db),
    Layer.succeed(MarketDataSource, MarketDataSource.of({ provider: "eodhd", retrieveDaily: retrieve })),
    Layer.succeed(
      RawMarketDataStore,
      RawMarketDataStore.of({
        store: (input) =>
          Effect.sync(() => {
            stored.push(input);
            return { key: rawMarketDataKey(input), etag: "raw-etag", rowCount: input.entries.length };
          }),
      }),
    ),
  );
  const ingest = () =>
    ingestMarketData({
      runId: "run-1",
      dataset: "prices_eod",
      symbol: "AAPL.US",
      range: { from: "2024-01-01", to: "2024-01-31" },
      createdAt: "2026-10-06T02:00:00Z",
    }).pipe(Effect.provide(layer), Effect.result, Effect.runPromise);
  const runRow = () =>
    ({ ...(sqlite.prepare("SELECT status, object_key, row_count, error FROM ingestion_runs").get() as object) });
  return { stored, ingest, runRow };
};

test("a successful download stores one raw object and completes the run", async () => {
  const { stored, ingest, runRow } = setup(() => Effect.succeed([entry("2024-01-02"), entry("2024-01-03")]));
  const result = await ingest();

  assert.equal(result._tag, "Success");
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.dataset, "prices_eod");
  assert.deepEqual(runRow(), {
    status: "completed",
    object_key: "dataset=prices_eod/symbol=AAPL.US/run=run-1.json",
    row_count: 2,
    error: null,
  });
});

test("a provider failure marks the run failed", async () => {
  const { stored, ingest, runRow } = setup(() =>
    Effect.fail(new MarketDataError({ kind: "request", message: "The EODHD request failed" })),
  );
  const result = await ingest();

  assert.equal(result._tag, "Failure");
  assert.equal(stored.length, 0);
  assert.deepEqual(runRow(), { status: "failed", object_key: null, row_count: null, error: "The EODHD request failed" });
});
