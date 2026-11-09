import { Schema } from "effect";

import { MarketDateSchema, MarketSymbolSchema } from "$/market-data/schemas";

/** The holdings date of a single-asset portfolio's only snapshot. */
export const SINGLE_ASSET_HOLDINGS_DATE = "1900-01-01";

/** Most holdings one snapshot can have. */
export const MAX_SNAPSHOT_HOLDINGS = 5000;

export const PortfolioIdSchema = Schema.String.check(Schema.isUUID());

export const PortfolioNameSchema = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200));

export const HoldingSchema = Schema.Struct({
  symbol: MarketSymbolSchema,
  weight: Schema.Finite.check(Schema.makeFilter((weight) => weight !== 0 || "Weight must be non-zero")),
});
export type Holding = typeof HoldingSchema.Type;

/** One snapshot's holdings: at least one, each symbol once. */
export const HoldingsSchema = Schema.Array(HoldingSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SNAPSHOT_HOLDINGS),
  Schema.makeFilter((holdings) =>
    new Set(holdings.map((holding) => holding.symbol)).size === holdings.length ||
    "Each symbol can appear only once",
  ),
);

export const NewSnapshotSchema = Schema.Struct({
  holdingsDate: MarketDateSchema,
  holdings: HoldingsSchema,
});
export type NewSnapshot = typeof NewSnapshotSchema.Type;

export const CreatePortfolioSchema = Schema.Struct({
  name: PortfolioNameSchema,
  snapshot: Schema.optionalKey(NewSnapshotSchema),
});
export type CreatePortfolio = typeof CreatePortfolioSchema.Type;

export const RenamePortfolioSchema = Schema.Struct({ name: PortfolioNameSchema });

export type * from "$/portfolios/views";

/** A portfolio as the calculation engine takes it in run and ad hoc requests. */
export interface EnginePortfolio {
  readonly id: string;
  readonly name: string;
  readonly snapshots: readonly { readonly holdingsDate: string; readonly holdings: readonly Holding[] }[];
}

export class PortfolioError extends Schema.TaggedError<PortfolioError>()("PortfolioError", {
  /** `no_holdings`: no snapshot on or before the as-of date of a calculation. */
  kind: Schema.Literals(["database", "not_found", "conflict", "untracked_symbols", "no_holdings"]),
  message: Schema.String,
  /** The untracked symbols, for `untracked_symbols`. */
  symbols: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The calculations using a portfolio that can't be deleted, for `conflict`. */
  calculations: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))),
}) {}
