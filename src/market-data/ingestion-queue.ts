import { Effect, type Layer } from "effect";

import { type MarketDataError, type MarketDataSource } from "$/market-data";
import { type ControlPlaneError, MarketDataControlPlane } from "$/market-data/control-plane";
import { ingestMarketData } from "$/market-data/ingestion";
import type { ProcessingMessage } from "$/market-data/processing";
import type { Dataset, DateRange } from "$/market-data/schemas";
import { SymbolRegistry, type SymbolRegistryError } from "$/market-data/symbol-registry";

/** One symbol to download. `to` is fixed when queued so retries fetch the same range. */
export interface IngestionMessage {
  readonly dataset: Dataset;
  readonly symbol: string;
  readonly to: string;
}

export interface IngestionEntry {
  readonly dataset: Dataset;
  readonly symbol: string;
}

/** Most entries one request can queue. */
export const MAX_INGESTION_ENTRIES = 500;

/** A `fetching` run older than this is assumed dead (queue consumers stop after 15 minutes). */
export const STALE_RUN_MS = 30 * 60 * 1000;

const QUEUE_BATCH_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Snapshots run up to the previous UTC day, the last one with a final close. */
export const previousDay = (now: Date) => new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);

/**
 * Queue a full-history download for each registered entry. Rejects the whole
 * request, queuing nothing, if any entry cannot be downloaded.
 */
export const requestIngestions = Effect.fn("MarketData.requestIngestions")(function* (
  entries: readonly IngestionEntry[],
  queue: Pick<Queue<IngestionMessage>, "sendBatch">,
  now: Date,
) {
  const registry = yield* SymbolRegistry;
  const tracked = new Map(
    (yield* registry.list({})).map((symbol) => [`${symbol.dataset}/${symbol.symbol}`, symbol]),
  );
  const to = previousDay(now);

  const unique = [...new Map(entries.map((entry) => [`${entry.dataset}/${entry.symbol}`, entry])).values()];
  const queued: (IngestionEntry & { range: DateRange })[] = [];
  const rejected: (IngestionEntry & { reason: string })[] = [];
  for (const { dataset, symbol } of unique) {
    const registered = tracked.get(`${dataset}/${symbol}`);
    if (registered === undefined) {
      rejected.push({ dataset, symbol, reason: "The symbol is not registered" });
    } else if (registered.backfillStartDate > to) {
      rejected.push({ dataset, symbol, reason: `History starts after ${to}; nothing to download yet` });
    } else {
      queued.push({ dataset, symbol, range: { from: registered.backfillStartDate, to } });
    }
  }

  if (rejected.length > 0) {
    return { status: "rejected", rejected } as const;
  }

  for (let index = 0; index < queued.length; index += QUEUE_BATCH_SIZE) {
    const batch = queued.slice(index, index + QUEUE_BATCH_SIZE);
    yield* Effect.promise(() =>
      queue.sendBatch(batch.map(({ dataset, symbol }) => ({ body: { dataset, symbol, to } }))),
    );
  }
  return { status: "queued", queued } as const;
});

export type IngestionError = MarketDataError | ControlPlaneError | SymbolRegistryError;

/** Whether a failed ingestion message is worth redelivering. */
export const isRetryable = (error: IngestionError) => {
  switch (error._tag) {
    case "MarketDataError":
      // Bad configuration or unexpected provider data won't fix itself.
      return error.kind === "request" || error.kind === "storage";
    case "SymbolRegistryError":
      return error.kind === "database";
    case "ControlPlaneError":
      return true;
  }
};

/**
 * Download one queued symbol, then queue its processing job right away.
 * Each attempt gets a fresh run ID, so redelivery is always safe.
 */
export const runIngestion = Effect.fn("MarketData.runIngestion")(function* (
  message: IngestionMessage,
  dependencies: {
    readonly sourceFor: (provider: string) => Layer.Layer<MarketDataSource, MarketDataError>;
    readonly processingQueue: Pick<Queue<ProcessingMessage>, "send">;
  },
) {
  const registry = yield* SymbolRegistry;
  const controlPlane = yield* MarketDataControlPlane;
  const tracked = yield* registry.get(message.dataset, message.symbol);

  const now = new Date();
  const result = yield* ingestMarketData({
    runId: crypto.randomUUID(),
    dataset: message.dataset,
    symbol: message.symbol,
    range: { from: tracked.backfillStartDate, to: message.to },
    createdAt: now.toISOString(),
    staleBefore: new Date(now.getTime() - STALE_RUN_MS).toISOString(),
  }).pipe(Effect.provide(dependencies.sourceFor(tracked.provider)));
  if (result.status === "skipped") return { outcome: "already_running" } as const;

  // If the symbol already has an active job, the daily cron queues this run later.
  const jobId = yield* controlPlane.createJobForRun(result.runId, new Date().toISOString());
  if (jobId === undefined) return { outcome: "processing_deferred", runId: result.runId } as const;

  // D1 is the source of truth: if this send fails, the daily cron resends the job.
  yield* Effect.tryPromise(() => dependencies.processingQueue.send({ jobId })).pipe(
    Effect.tapError(() =>
      Effect.sync(() => console.error(JSON.stringify({ event: "processing_send_failed", jobId }))),
    ),
    Effect.ignore,
  );
  return { outcome: "processing_queued", runId: result.runId, jobId } as const;
});
