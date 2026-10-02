import { Context, Effect, Layer, Schema } from "effect";

import { subtractDateRanges, type DateRange } from "$/market-data/coverage";
import {
  type EodEntry,
  type EodEntriesBySymbol,
  EodEntriesBySymbolSchema,
  type MarketDataRequest,
} from "$/market-data/schemas";

export class MarketDataError extends Schema.TaggedError<MarketDataError>()(
  "MarketDataError",
  {
    kind: Schema.Literals([
      "configuration",
      "request",
      "response",
      "storage",
    ]),
    message: Schema.String,
    symbol: Schema.optionalKey(Schema.String),
  },
) {}

export interface MarketDataCacheKey {
  readonly provider: string;
  readonly symbol: string;
}

export interface StoreMarketData {
  readonly key: MarketDataCacheKey;
  readonly entries: readonly EodEntry[];
  readonly coverage: readonly DateRange[];
  readonly overwrite: boolean;
}

/** A provider adapter that returns canonical, validated market data. */
export class MarketDataSource extends Context.Service<
  MarketDataSource,
  {
    readonly provider: string;
    readonly retrieveDaily: (
      symbol: string,
      range: DateRange,
    ) => Effect.Effect<readonly EodEntry[], MarketDataError>;
  }
>()("data-service/MarketDataSource") {}

/** Provider-neutral storage for canonical market data and its coverage. */
export class MarketDataCache extends Context.Service<
  MarketDataCache,
  {
    readonly readCoverage: (
      key: MarketDataCacheKey,
    ) => Effect.Effect<readonly DateRange[], MarketDataError>;
    readonly readEntries: (
      key: MarketDataCacheKey,
      range: DateRange,
    ) => Effect.Effect<readonly EodEntry[], MarketDataError>;
    readonly store: (
      input: StoreMarketData,
    ) => Effect.Effect<void, MarketDataError>;
  }
>()("data-service/MarketDataCache") {}

/** Provider-neutral interface for retrieving validated daily market data. */
export class MarketData extends Context.Service<
  MarketData,
  {
    readonly retrieveDaily: (
      request: MarketDataRequest,
    ) => Effect.Effect<EodEntriesBySymbol, MarketDataError>;
  }
>()("data-service/MarketData") {}

const decodeOutput = Schema.decodeUnknownEffect(EodEntriesBySymbolSchema, {
  errors: "all",
});

const validateOutput = (input: unknown) =>
  decodeOutput(input).pipe(
    Effect.mapError(
      () =>
        new MarketDataError({
          kind: "response",
          message: "Could not construct the market-data response",
        }),
    ),
  );

const mergeEntries = (
  cached: readonly EodEntry[],
  fetched: readonly EodEntry[],
) => {
  const entriesByDate = new Map(
    cached.map((entry) => [entry.date, entry] as const),
  );

  for (const entry of fetched) {
    entriesByDate.set(entry.date, entry);
  }

  return [...entriesByDate.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
};

const retrieveSymbol = Effect.fn("MarketData.retrieveSymbol")(function* (
  source: MarketDataSource["Service"],
  cache: MarketDataCache["Service"],
  request: MarketDataRequest,
  symbol: string,
) {
  const requestedRange = { from: request.from, to: request.to };
  const key = { provider: source.provider, symbol };
  const coverage = yield* cache.readCoverage(key);
  const missingRanges = request.force
    ? [requestedRange]
    : subtractDateRanges(requestedRange, coverage);

  const cached = request.force
    ? []
    : yield* cache.readEntries(key, requestedRange);

  const fetchedByRange = yield* Effect.forEach(
    missingRanges,
    (range) => source.retrieveDaily(symbol, range),
    // Avoid an accidental burst of billed provider calls.
    { concurrency: 1 },
  );
  const fetched = fetchedByRange.flat();

  yield* cache.store({
    key,
    entries: fetched,
    coverage: missingRanges,
    overwrite: request.force,
  });

  return [symbol, mergeEntries(cached, fetched)] as const;
});

const makeMarketData = Effect.gen(function* () {
  const source = yield* MarketDataSource;
  const cache = yield* MarketDataCache;

  return MarketData.of({
    retrieveDaily: (request) =>
      Effect.forEach(
        request.symbols,
        (symbol) => retrieveSymbol(source, cache, request, symbol),
        { concurrency: 1 },
      ).pipe(
        Effect.flatMap((entries) =>
          validateOutput(Object.fromEntries(entries)),
        ),
        Effect.withSpan("MarketData.retrieveSymbols"),
      ),
  });
});

/** Cache-aware market-data implementation, independent of provider and storage. */
export const MarketDataLive: Layer.Layer<
  MarketData,
  never,
  MarketDataSource | MarketDataCache
> = Layer.effect(MarketData, makeMarketData);

/**
 * Provider-neutral program for retrieving daily market data.
 *
 * Request data stays explicit while the provider is selected through the
 * MarketData service in the Effect environment.
 */
export const retrieveDailyMarketData = Effect.fn("MarketData.retrieveDaily")(
  function* (request: MarketDataRequest) {
    const marketData = yield* MarketData;
    return yield* marketData.retrieveDaily(request);
  },
);
