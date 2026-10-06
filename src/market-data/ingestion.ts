import { Context, Effect } from "effect";

import { MarketDataError, MarketDataSource } from "$/market-data";
import {
  MarketDataControlPlane,
  type IngestionRunObject,
} from "$/market-data/control-plane";
import type { DateRange } from "$/market-data/coverage";
import type { EodEntry } from "$/market-data/schemas";

export interface StoreRawMarketData {
  readonly runId: string;
  readonly provider: string;
  readonly symbol: string;
  readonly requestedRange: DateRange;
  readonly entries: readonly EodEntry[];
  readonly receivedAt: string;
}

export class RawMarketDataStore extends Context.Service<
  RawMarketDataStore,
  {
    readonly store: (
      input: StoreRawMarketData,
    ) => Effect.Effect<IngestionRunObject, MarketDataError>;
  }
>()("data-service/RawMarketDataStore") {}

export interface IngestDailyMarketData {
  readonly runId: string;
  readonly symbol: string;
  readonly range: DateRange;
  readonly createdAt: string;
}

/**
 * Fetch one symbol range and persist it as one immutable ingestion run.
 *
 * The caller supplies the run ID and timestamp so scheduling and retries can
 * retain the same identity instead of accidentally creating duplicate runs.
 */
export const ingestDailyMarketData = Effect.fn("MarketData.ingestDaily")(
  function* (input: IngestDailyMarketData) {
    const source = yield* MarketDataSource;
    const rawStore = yield* RawMarketDataStore;
    const controlPlane = yield* MarketDataControlPlane;

    yield* controlPlane.startIngestionRun({
      runId: input.runId,
      provider: source.provider,
      symbol: input.symbol,
      requestedRange: input.range,
      createdAt: input.createdAt,
    });

    return yield* Effect.gen(function* () {
      const entries = yield* source.retrieveDaily(input.symbol, input.range);
      const receivedAt = new Date().toISOString();
      const object = yield* rawStore.store({
        runId: input.runId,
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

      return {
        runId: input.runId,
        provider: source.provider,
        symbol: input.symbol,
        requestedRange: input.range,
        object,
      } as const;
    }).pipe(
      Effect.tapError((error) =>
        controlPlane
          .failIngestionRun(
            input.runId,
            error.message,
            new Date().toISOString(),
          )
          .pipe(Effect.ignore),
      ),
    );
  },
);
