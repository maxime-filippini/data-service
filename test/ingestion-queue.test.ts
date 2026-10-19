import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer } from "effect";

import { requireManagementToken } from "$/auth";
import { MarketDataError, MarketDataSource } from "$/market-data";
import { ControlPlaneError } from "$/market-data/control-plane";
import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import { RawMarketDataStore } from "$/market-data/ingestion";
import { type IngestionMessage, isRetryable, runIngestion } from "$/market-data/ingestion-queue";
import { rawMarketDataKey } from "$/market-data/r2-raw-store";
import { SymbolRegistryError } from "$/market-data/symbol-registry";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { createIngestionRoutes } from "$/routes/ingestions";
import { makeTestDatabase } from "./support/d1";

const entry = (date: string) => ({ date, open: 1, close: 1, high: 1, low: 1, adjusted_close: 1, volume: 1 });

const setup = () => {
  const { sqlite, db } = makeTestDatabase();
  const register = (symbol: string, backfillStartDate = "2016-01-01") =>
    sqlite
      .prepare(
        `INSERT INTO tracked_symbols (dataset, symbol, provider, enabled, backfill_start_date, created_at, updated_at)
         VALUES ('prices_eod', ?, 'eodhd', 1, ?, 'now', 'now')`,
      )
      .run(symbol, backfillStartDate);

  // Routes
  const ingestionMessages: IngestionMessage[] = [];
  const env = {
    MANAGEMENT_API_TOKEN: "management",
    INGESTION_QUEUE: {
      sendBatch: async (messages: Iterable<MessageSendRequest<IngestionMessage>>) => {
        const batch = [...messages];
        assert.ok(batch.length <= 100);
        ingestionMessages.push(...batch.map((message) => message.body));
      },
    },
  } as unknown as CloudflareBindings;
  const app = createIngestionRoutes(() => D1SymbolRegistryLive(db), requireManagementToken);
  const post = (body: unknown, token = "management") =>
    app.request(
      "/",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );

  // Consumer
  const requestedRanges: { from: string; to: string }[] = [];
  const processingMessages: string[] = [];
  const layer = Layer.mergeAll(
    D1SymbolRegistryLive(db),
    D1MarketDataControlPlaneLive(db),
    Layer.succeed(
      RawMarketDataStore,
      RawMarketDataStore.of({
        store: (input) =>
          Effect.succeed({ key: rawMarketDataKey(input), etag: "raw-etag", rowCount: input.entries.length }),
      }),
    ),
  );
  const source = Layer.succeed(
    MarketDataSource,
    MarketDataSource.of({
      provider: "eodhd",
      retrieveDaily: (_symbol, range) =>
        Effect.sync(() => {
          requestedRanges.push(range);
          return [entry(range.to)];
        }),
    }),
  );
  const ingest = (symbol: string, to = "2026-10-17") =>
    runIngestion(
      { dataset: "prices_eod", symbol, to },
      {
        sourceFor: () => source,
        processingQueue: {
          send: async (body: { jobId: string }) => {
            processingMessages.push(body.jobId);
            return {} as QueueSendResponse;
          },
        },
      },
    ).pipe(Effect.provide(layer), Effect.result, Effect.runPromise);

  const runs = () =>
    sqlite
      .prepare("SELECT symbol, status, error FROM ingestion_runs ORDER BY created_at, run_id")
      .all()
      .map((row) => ({ ...row })) as { symbol: string; status: string; error: string | null }[];

  return { sqlite, register, post, ingestionMessages, ingest, requestedRanges, processingMessages, runs };
};

const aapl = { dataset: "prices_eod", symbol: "AAPL.US" };

test("the ingestion route requires the management token and a valid body", async () => {
  const { post, register } = setup();
  register("AAPL.US");
  assert.equal((await post({ entries: [aapl] }, "wrong")).status, 401);
  assert.equal((await post({ entries: [] })).status, 400);
  assert.equal((await post({ entries: [{ ...aapl, symbol: "aapl" }] })).status, 400);
  assert.equal((await post({ entries: [aapl], extra: true })).status, 400);
});

test("registered entries are queued once each, up to the previous day", async () => {
  const { post, register, ingestionMessages } = setup();
  register("AAPL.US");
  register("MSFT.US", "2020-01-01");

  const response = await post({ entries: [aapl, { ...aapl, symbol: "MSFT.US" }, aapl] });
  assert.equal(response.status, 202);
  const { queued } = (await response.json()) as { queued: { symbol: string; range: { from: string; to: string } }[] };
  const to = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(
    queued.map((item) => [item.symbol, item.range]),
    [
      ["AAPL.US", { from: "2016-01-01", to }],
      ["MSFT.US", { from: "2020-01-01", to }],
    ],
  );
  assert.deepEqual(ingestionMessages, [
    { dataset: "prices_eod", symbol: "AAPL.US", to },
    { dataset: "prices_eod", symbol: "MSFT.US", to },
  ]);
});

test("a request with an unregistered entry is rejected and queues nothing", async () => {
  const { post, register, ingestionMessages } = setup();
  register("AAPL.US");
  register("NEW.US", new Date().toISOString().slice(0, 10));

  const response = await post({ entries: [aapl, { ...aapl, symbol: "MSFT.US" }, { ...aapl, symbol: "NEW.US" }] });
  assert.equal(response.status, 400);
  const { rejected } = (await response.json()) as { rejected: { symbol: string }[] };
  assert.deepEqual(rejected.map((item) => item.symbol), ["MSFT.US", "NEW.US"]);
  assert.equal(ingestionMessages.length, 0);
});

test("a queued ingestion downloads full history and queues its processing job", async () => {
  const { register, ingest, requestedRanges, processingMessages, runs, sqlite } = setup();
  register("AAPL.US");

  const result = await ingest("AAPL.US");
  assert.equal(result._tag, "Success");
  assert.equal(result._tag === "Success" && result.success.outcome, "processing_queued");
  assert.deepEqual(requestedRanges, [{ from: "2016-01-01", to: "2026-10-17" }]);
  assert.deepEqual(runs(), [{ symbol: "AAPL.US", status: "completed", error: null }]);

  const jobs = sqlite.prepare("SELECT job_id, status FROM processing_jobs").all() as { job_id: string; status: string }[];
  assert.deepEqual(jobs.map((job) => job.status), ["queued"]);
  assert.deepEqual(processingMessages, [jobs[0]!.job_id]);
});

test("a symbol with a download in progress is skipped until that run goes stale", async () => {
  const { register, ingest, requestedRanges, runs, sqlite } = setup();
  register("AAPL.US");
  const addFetching = (createdAt: string) =>
    sqlite
      .prepare(
        `INSERT INTO ingestion_runs (run_id, dataset, symbol, provider, requested_from, requested_to, status, created_at)
         VALUES (?, 'prices_eod', 'AAPL.US', 'eodhd', '2016-01-01', '2026-10-17', 'fetching', ?)`,
      )
      .run(`fetching-${createdAt}`, createdAt);

  addFetching(new Date().toISOString());
  const skipped = await ingest("AAPL.US");
  assert.equal(skipped._tag === "Success" && skipped.success.outcome, "already_running");
  assert.equal(requestedRanges.length, 0);

  // A run stuck for over 30 minutes is failed and no longer blocks downloads.
  sqlite.exec("DELETE FROM ingestion_runs");
  addFetching(new Date(Date.now() - 60 * 60 * 1000).toISOString());
  const result = await ingest("AAPL.US");
  assert.equal(result._tag === "Success" && result.success.outcome, "processing_queued");
  assert.deepEqual(
    runs().map((run) => [run.status, run.error]),
    [["failed", "Timed out while fetching"], ["completed", null]],
  );
});

test("a new run waits for the daily cron while the symbol has an active job", async () => {
  const { register, ingest, processingMessages } = setup();
  register("AAPL.US");
  await ingest("AAPL.US");

  const result = await ingest("AAPL.US");
  assert.equal(result._tag === "Success" && result.success.outcome, "processing_deferred");
  assert.equal(processingMessages.length, 1);
});

test("an unregistered symbol fails without retrying", async () => {
  const { ingest } = setup();
  const result = await ingest("AAPL.US");
  assert.ok(result._tag === "Failure" && !isRetryable(result.failure));
});

test("only transient failures are retried", () => {
  const marketData = (kind: MarketDataError["kind"]) => new MarketDataError({ kind, message: kind });
  assert.equal(isRetryable(marketData("request")), true);
  assert.equal(isRetryable(marketData("storage")), true);
  assert.equal(isRetryable(marketData("response")), false);
  assert.equal(isRetryable(marketData("configuration")), false);
  assert.equal(isRetryable(new ControlPlaneError({ message: "db" })), true);
  assert.equal(isRetryable(new SymbolRegistryError({ kind: "database", message: "db" })), true);
  assert.equal(isRetryable(new SymbolRegistryError({ kind: "not_found", message: "missing" })), false);
});
