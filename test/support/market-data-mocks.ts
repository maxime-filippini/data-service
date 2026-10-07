import { Effect, Layer } from "effect";

import {
  MarketDataLive,
  MarketDataSource,
  retrieveDailyMarketData,
} from "$/market-data";
import type { DateRange } from "$/market-data/coverage";
import type {
  EodEntry,
  MarketDataRequest,
} from "$/market-data/schemas";

interface MarketDataTestHarnessOptions {
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
 * Runs the public MarketData program with a controllable provider.
 * Recorded requests expose which symbols and ranges were fetched.
 */
export const makeMarketDataTestHarness = (
  options: MarketDataTestHarnessOptions,
) => {
  const sourceRequests: SourceRequest[] = [];

  const source = MarketDataSource.of({
    provider: "test-provider",
    retrieveDaily: (symbol, range) =>
      Effect.sync(() => {
        sourceRequests.push({ symbol, range });
        return entriesWithin(options.providerEntries, range);
      }),
  });

  const dependencies = Layer.succeed(MarketDataSource, source);
  const marketData = MarketDataLive.pipe(Layer.provide(dependencies));

  return {
    sourceRequests,
    retrieve: (request: MarketDataRequest) =>
      retrieveDailyMarketData(request).pipe(
        Effect.provide(marketData),
        Effect.runPromise,
      ),
  };
};
