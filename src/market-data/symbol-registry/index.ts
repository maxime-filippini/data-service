import { Context, Effect, Schema } from "effect";
import { MarketDateSchema, MarketSymbolSchema } from "$/market-data/schemas";

export const RegisterSymbolSchema = Schema.Struct({
  symbol: MarketSymbolSchema,
  provider: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  backfillStartDate: MarketDateSchema,
}).check(Schema.makeFilter((input) =>
  input.backfillStartDate <= new Date().toISOString().slice(0, 10)
    ? true
    : { path: ["backfillStartDate"], issue: "The start date must not be in the future" },
));

export type SymbolConfiguration = typeof RegisterSymbolSchema.Type;

export interface TrackedSymbol extends SymbolConfiguration {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
}

export interface ListSymbols {
  readonly enabled?: boolean;
  readonly limit: number;
  readonly after?: SymbolIdentity;
}

export interface SymbolIdentity {
  readonly symbol: string;
  readonly provider: string;
}

export class SymbolRegistryError extends Schema.TaggedError<SymbolRegistryError>()(
  "SymbolRegistryError",
  {
    kind: Schema.Literals(["database", "not_found"]),
    message: Schema.String,
    symbol: Schema.optionalKey(Schema.String),
  },
) {}

/** Policy only: registry changes never fetch data or alter execution history. */
export class SymbolRegistry extends Context.Service<SymbolRegistry, {
  readonly register: (input: SymbolConfiguration, now: string) => Effect.Effect<
    { readonly symbol: TrackedSymbol; readonly created: boolean }, SymbolRegistryError
  >;
  readonly list: (input: ListSymbols) => Effect.Effect<readonly TrackedSymbol[], SymbolRegistryError>;
  readonly disable: (identity: SymbolIdentity, now: string) => Effect.Effect<TrackedSymbol, SymbolRegistryError>;
}>()("data-service/SymbolRegistry") {}
