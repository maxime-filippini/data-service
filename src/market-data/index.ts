import { Context, Effect, Schema } from "effect";

import type { DateRange, Provider } from "$/market-data/schemas";

export class MarketDataError extends Schema.TaggedError<MarketDataError>()(
  "MarketDataError",
  {
    kind: Schema.Literals(["configuration", "request", "response", "storage"]),
    message: Schema.String,
    symbol: Schema.optionalKey(Schema.String),
  },
) {}

/** A dated row returned by a provider adapter, already validated by it. */
export interface DatedEntry {
  readonly date: string;
}

/** A provider adapter that returns validated rows for one symbol and range. */
export class MarketDataSource extends Context.Service<
  MarketDataSource,
  {
    readonly provider: Provider;
    readonly retrieveDaily: (
      symbol: string,
      range: DateRange,
    ) => Effect.Effect<readonly DatedEntry[], MarketDataError>;
  }
>()("data-service/MarketDataSource") {}
