import { Context, Effect, Schema } from "effect";

import type { DateRange, Provider } from "$/market-data/schemas";

/**
 * Expected provider configuration/request/response or raw-storage failure.
 * Queue orchestration uses `kind` to decide which download failures can retry;
 * messages should describe the failure without exposing provider credentials.
 */
export class MarketDataError extends Schema.TaggedError<MarketDataError>()(
  "MarketDataError",
  {
    kind: Schema.Literals(["configuration", "request", "response", "storage"]),
    message: Schema.String,
    symbol: Schema.optionalKey(Schema.String),
  },
) {}

/**
 * Minimal common shape of an already validated provider row. Shared ingestion
 * and raw-storage code needs the date to report the observed range; concrete
 * adapters retain dataset-specific fields such as prices and volume.
 */
export interface DatedEntry {
  readonly date: string;
}

/**
 * Injectable provider interface used by ingestion to fetch validated daily
 * rows for one symbol/range. The caller selects an adapter for the registered
 * provider; this interface fetches data without changing D1 run state or R2 storage.
 */
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
