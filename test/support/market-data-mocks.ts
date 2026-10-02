import { Effect, Layer } from "effect";

import {
  MarketDataCache,
  MarketDataLive,
  MarketDataSource,
  retrieveDailyMarketData,
  type StoreMarketData,
} from "$/market-data";
import type { DateRange } from "$/market-data/coverage";
import type {
  EodEntry,
  MarketDataRequest,
} from "$/market-data/schemas";

interface MarketDataTestHarnessOptions {
  readonly coverage: readonly DateRange[];
  readonly cachedEntries: readonly EodEntry[];
  readonly providerEntries: readonly EodEntry[];
}

interface SourceRequest {
  readonly symbol: string;
  readonly range: DateRange;
}

const entriesWithin = (
  entries: readonly EodEntry[],
  range: DateRange,
) => entries.filter(({ date }) => date >= range.from && date <= range.to);

export const makeEodEntry = (date: string): EodEntry => ({
  date,
  open: 100,
  close: 101,
  high: 102,
  low: 99,
  adjusted_close: 101,
  volume: 1_000,
});

/**
 * Runs the public MarketData program with controllable source and cache
 * boundaries. Recorded requests make cache hit/miss decisions visible.
 */
export const makeMarketDataTestHarness = (
  options: MarketDataTestHarnessOptions,
) => {
  const sourceRequests: SourceRequest[] = [];
  const storeRequests: StoreMarketData[] = [];

  const source = MarketDataSource.of({
    provider: "test-provider",
    retrieveDaily: (symbol, range) =>
      Effect.sync(() => {
        sourceRequests.push({ symbol, range });
        return entriesWithin(options.providerEntries, range);
      }),
  });

  const cache = MarketDataCache.of({
    readCoverage: () => Effect.succeed(options.coverage),
    readEntries: (_key, range) =>
      Effect.succeed(entriesWithin(options.cachedEntries, range)),
    store: (input) =>
      Effect.sync(() => {
        storeRequests.push(input);
      }),
  });

  const dependencies = Layer.merge(
    Layer.succeed(MarketDataSource, source),
    Layer.succeed(MarketDataCache, cache),
  );
  const marketData = MarketDataLive.pipe(Layer.provide(dependencies));

  return {
    sourceRequests,
    storeRequests,
    retrieve: (request: MarketDataRequest) =>
      retrieveDailyMarketData(request).pipe(
        Effect.provide(marketData),
        Effect.runPromise,
      ),
  };
};
