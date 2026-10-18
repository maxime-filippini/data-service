import { Context, Effect } from "effect";

import { type DatedEntry, MarketDataError, MarketDataSource } from "$/market-data";
import { MarketDataControlPlane, type RawObject } from "$/market-data/control-plane";
import type { Dataset, DateRange, Provider } from "$/market-data/schemas";

export interface StoreRawMarketData {
  readonly runId: string;
  readonly dataset: Dataset;
  readonly provider: Provider;
  readonly symbol: string;
  readonly requestedRange: DateRange;
  readonly entries: readonly DatedEntry[];
  readonly receivedAt: string;
}

export class RawMarketDataStore extends Context.Service<
  RawMarketDataStore,
  {
    readonly store: (input: StoreRawMarketData) => Effect.Effect<RawObject, MarketDataError>;
  }
>()("data-service/RawMarketDataStore") {}

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
