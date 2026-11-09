import { Context, Effect, Schema } from "effect";

import { utcDay } from "$/datetime";
import {
  type Dataset,
  DatasetSchema,
  datasetProviders,
  MarketDateSchema,
  MarketSymbolSchema,
  ProviderSchema,
} from "$/market-data/schemas";

/**
 * HTTP upsert input for a tracked `(dataset, symbol)`. Validates provider
 * compatibility and a non-future history start; registering updates scheduling
 * settings without downloading data. Omitted `enabled` is interpreted as true.
 */
export const RegisterSymbolSchema = Schema.Struct({
  dataset: DatasetSchema,
  symbol: MarketSymbolSchema,
  provider: ProviderSchema,
  backfillStartDate: MarketDateSchema,
  enabled: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter((input) =>
    datasetProviders[input.dataset].includes(input.provider)
      ? true
      : {
          path: ["provider"],
          issue: `Provider cannot supply dataset ${input.dataset}`,
        },
  ),
  Schema.makeFilter((input) =>
    input.backfillStartDate <= utcDay(new Date())
      ? true
      : {
          path: ["backfillStartDate"],
          issue: "The start date must not be in the future",
        },
  ),
);

/**
 * Decoded registry upsert passed to `SymbolRegistry.register`. Re-registering
 * an existing pair updates its settings; the store supplies timestamps and
 * creates a managed single-asset portfolio for a new prices_eod symbol.
 */
export type RegisterSymbol = typeof RegisterSymbolSchema.Type;

/**
 * Persisted download-universe entry keyed by dataset and symbol. Its provider
 * and backfill start configure future downloads; disabling removes it from
 * daily scheduling while preserving history and allowing manual downloads.
 */
export interface TrackedSymbol {
  readonly dataset: Dataset;
  readonly symbol: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly backfillStartDate: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Expected registry read/write failure or missing tracked symbol. Used by
 * HTTP routes and ingestion consumers to distinguish absent configuration from
 * a database outage; provider download failures use `MarketDataError` instead.
 */
export class SymbolRegistryError extends Schema.TaggedError<SymbolRegistryError>()(
  "SymbolRegistryError",
  {
    kind: Schema.Literals(["database", "not_found"]),
    message: Schema.String,
  },
) {}

/**
 * Injectable interface for reading and updating the download universe.
 * `D1SymbolRegistryLive` supplies persistence and atomic single-asset creation.
 * Mutations configure future work without fetching data or deleting history.
 */
export class SymbolRegistry extends Context.Service<
  SymbolRegistry,
  {
    readonly register: (
      input: RegisterSymbol,
      now: string,
    ) => Effect.Effect<
      { readonly symbol: TrackedSymbol; readonly created: boolean },
      SymbolRegistryError
    >;
    readonly list: (filter: {
      readonly dataset?: Dataset;
      readonly enabled?: boolean;
    }) => Effect.Effect<readonly TrackedSymbol[], SymbolRegistryError>;
    readonly get: (
      dataset: Dataset,
      symbol: string,
    ) => Effect.Effect<TrackedSymbol, SymbolRegistryError>;
    /** Put a symbol on or take it off the daily schedule. Keeps history either way. */
    readonly setEnabled: (
      dataset: Dataset,
      symbol: string,
      enabled: boolean,
      now: string,
    ) => Effect.Effect<TrackedSymbol, SymbolRegistryError>;
  }
>()("data-service/SymbolRegistry") {}
