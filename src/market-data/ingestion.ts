import { Context, Effect } from "effect";

import {
  type DatedEntry,
  MarketDataError,
  MarketDataSource,
} from "$/market-data";
import {
  MarketDataControlPlane,
  type RawObject,
} from "$/market-data/control-plane";
import type { Dataset, DateRange, Provider } from "$/market-data/schemas";

/**
 * Validated provider response plus request provenance passed to raw storage.
 * The R2 adapter writes a versioned JSON envelope and returns a `RawObject`
 * receipt; these entries are raw rows, not the canonical Parquet representation.
 */
export interface StoreRawMarketData {
  readonly runId: string;
  readonly dataset: Dataset;
  readonly provider: Provider;
  readonly symbol: string;
  readonly requestedRange: DateRange;
  readonly entries: readonly DatedEntry[];
  readonly receivedAt: string;
}

/**
 * Injectable write-only interface for preserving a raw provider response.
 * `ingestMarketData` obtains it through Effect; the R2 adapter owns envelope
 * serialization and write-once storage, while tests can capture the same input.
 */
export class RawMarketDataStore extends Context.Service<
  RawMarketDataStore,
  {
    readonly store: (
      input: StoreRawMarketData,
    ) => Effect.Effect<RawObject, MarketDataError>;
  }
>()("data-service/RawMarketDataStore") {}

/**
 * One prepared download attempt passed to `ingestMarketData`. The queue
 * consumer resolves registration into this explicit range and supplies a fresh
 * run ID/timestamps; the operation claims the run before fetching or storing data.
 */
export interface IngestMarketData {
  readonly runId: string;
  readonly dataset: Dataset;
  readonly symbol: string;
  readonly range: DateRange;
  readonly createdAt: string;
  readonly staleBefore: string;
}

/**
 * Download one symbol's range and record it as one immutable ingestion run.
 * Skips the download if the symbol already has a run in progress.
 */
export const ingestMarketData = Effect.fn("MarketData.ingest")(function* (
  input: IngestMarketData,
) {
  const source = yield* MarketDataSource;
  const rawStore = yield* RawMarketDataStore;
  const controlPlane = yield* MarketDataControlPlane;

  const started = yield* controlPlane.startIngestionRun({
    runId: input.runId,
    dataset: input.dataset,
    symbol: input.symbol,
    provider: source.provider,
    requestedRange: input.range,
    createdAt: input.createdAt,
    staleBefore: input.staleBefore,
  });
  if (!started) return { status: "skipped" } as const;

  return yield* Effect.gen(function* () {
    const entries = yield* source.retrieveDaily(input.symbol, input.range);
    const receivedAt = new Date().toISOString();
    const object = yield* rawStore.store({
      runId: input.runId,
      dataset: input.dataset,
      provider: source.provider,
      symbol: input.symbol,
      requestedRange: input.range,
      entries,
      receivedAt,
    });

    yield* controlPlane.completeIngestionRun({
      runId: input.runId,
      object,
      completedAt: receivedAt,
    });

    return { status: "completed", runId: input.runId, object } as const;
  }).pipe(
    Effect.tapError((error) =>
      controlPlane
        .failIngestionRun(input.runId, error.message, new Date().toISOString())
        .pipe(Effect.ignore),
    ),
  );
});
