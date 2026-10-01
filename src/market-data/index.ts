import { Context, Effect, Schema, SchemaGetter } from "effect";

import {
  type EodEntriesBySymbol,
  isDateOnly,
  type MarketDataRequest,
  MarketDateSchema,
} from "$/market-data/schemas";

export class MarketDataError extends Schema.TaggedError<MarketDataError>()(
  "MarketDataError",
  {
    kind: Schema.Literals(["configuration", "request", "response"]),
    message: Schema.String,
    symbol: Schema.optionalKey(Schema.String),
  },
) {}

/** Provider-neutral interface for retrieving validated daily market data. */
export class MarketData extends Context.Service<
  MarketData,
  {
    readonly retrieveDaily: (
      request: MarketDataRequest,
    ) => Effect.Effect<EodEntriesBySymbol, MarketDataError>;
  }
>()("data-service/MarketData") {}

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
