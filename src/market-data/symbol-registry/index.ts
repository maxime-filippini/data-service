import { Context, Effect, Schema } from "effect";

import {
  type Dataset,
  DatasetSchema,
  datasetProviders,
  MarketDateSchema,
  MarketSymbolSchema,
  ProviderSchema,
} from "$/market-data/schemas";

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
      : { path: ["provider"], issue: `Provider cannot supply dataset ${input.dataset}` },
  ),
  Schema.makeFilter((input) =>
    input.backfillStartDate <= new Date().toISOString().slice(0, 10)
      ? true
      : { path: ["backfillStartDate"], issue: "The start date must not be in the future" },
  ),
);

export type RegisterSymbol = typeof RegisterSymbolSchema.Type;

export interface TrackedSymbol {
  readonly dataset: Dataset;
  readonly symbol: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly backfillStartDate: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class SymbolRegistryError extends Schema.TaggedError<SymbolRegistryError>()(
  "SymbolRegistryError",
  {
    kind: Schema.Literals(["database", "not_found"]),
    message: Schema.String,
  },
) {}

/** The download universe. Changes here never fetch data or delete history. */
export class SymbolRegistry extends Context.Service<
  SymbolRegistry,
  {
    readonly register: (
      input: RegisterSymbol,
      now: string,
    ) => Effect.Effect<{ readonly symbol: TrackedSymbol; readonly created: boolean }, SymbolRegistryError>;
    readonly list: (filter: {
      readonly dataset?: Dataset;
      readonly enabled?: boolean;
    }) => Effect.Effect<readonly TrackedSymbol[], SymbolRegistryError>;
    readonly get: (dataset: Dataset, symbol: string) => Effect.Effect<TrackedSymbol, SymbolRegistryError>;
    /** Put a symbol on or take it off the daily schedule. Keeps history either way. */
    readonly setEnabled: (
      dataset: Dataset,
      symbol: string,
      enabled: boolean,
      now: string,
    ) => Effect.Effect<TrackedSymbol, SymbolRegistryError>;
  }
>()("data-service/SymbolRegistry") {}
