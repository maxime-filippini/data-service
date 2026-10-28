import { Context, type Effect, Schema } from "effect";

import { MarketDateSchema, MarketSymbolSchema } from "$/market-data/schemas";
import type { Portfolio, PortfolioSummary, Snapshot } from "$/portfolios/views";

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

/**
 * Portfolios and their holdings snapshots. Every held symbol is a tracked
 * `prices_eod` symbol (disabled ones count) and a portfolio has at most one
 * snapshot per holdings date. Snapshots are added or deleted, never edited.
 * Single-asset portfolios come with their symbol and can't be changed: renaming
 * one, deleting it or changing its snapshots is a conflict.
 */
export class Portfolios extends Context.Service<
  Portfolios,
  {
    /** Every portfolio, by name. */
    readonly list: () => Effect.Effect<readonly PortfolioSummary[], PortfolioError>;
    readonly get: (id: string) => Effect.Effect<Portfolio, PortfolioError>;
    readonly create: (input: CreatePortfolio, id: string, now: string) => Effect.Effect<Portfolio, PortfolioError>;
    readonly rename: (id: string, name: string, now: string) => Effect.Effect<Portfolio, PortfolioError>;
    /** Delete a portfolio and its snapshots. A conflict if a calculation uses it. */
    readonly remove: (id: string) => Effect.Effect<void, PortfolioError>;
    readonly addSnapshot: (id: string, snapshot: NewSnapshot, now: string) => Effect.Effect<Snapshot, PortfolioError>;
    readonly removeSnapshot: (id: string, holdingsDate: string, now: string) => Effect.Effect<void, PortfolioError>;
    /** Fails with `untracked_symbols` unless every symbol is a tracked `prices_eod` symbol. */
    readonly requireTracked: (symbols: readonly string[]) => Effect.Effect<void, PortfolioError>;
    /** A portfolio with the snapshots dated on or before `asOf`, for the engine. */
    readonly forEngine: (id: string, asOf: string) => Effect.Effect<EnginePortfolio, PortfolioError>;
  }
>()("data-service/Portfolios") {}
