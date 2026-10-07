import { Context, Effect, Layer, Schema } from "effect";

import type { DateRange } from "$/market-data/coverage";
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

const retrieveSymbol = Effect.fn("MarketData.retrieveSymbol")(function* (
  source: MarketDataSource["Service"],
  request: MarketDataRequest,
  symbol: string,
) {
  const requestedRange = { from: request.from, to: request.to };
  const entries = yield* source.retrieveDaily(symbol, requestedRange);
  return [symbol, entries] as const;
});

const makeMarketData = Effect.gen(function* () {
  const source = yield* MarketDataSource;

  return MarketData.of({
    retrieveDaily: (request) =>
      Effect.forEach(
        request.symbols,
        (symbol) => retrieveSymbol(source, request, symbol),
        // Avoid an accidental burst of billed provider calls.
        { concurrency: 1 },
      ).pipe(
        Effect.flatMap((entries) =>
          validateOutput(Object.fromEntries(entries)),
        ),
        Effect.withSpan("MarketData.retrieveSymbols"),
      ),
  });
});

/** Direct provider retrieval without persistence or cache access. */
export const MarketDataLive: Layer.Layer<
  MarketData,
  never,
  MarketDataSource
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
