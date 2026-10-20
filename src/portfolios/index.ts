import { Context, type Effect, Schema } from "effect";

import { MarketDateSchema, MarketSymbolSchema } from "$/market-data/schemas";

/** Most holdings one snapshot can have. */
export const MAX_SNAPSHOT_HOLDINGS = 5000;

export const PortfolioIdSchema = Schema.String.check(Schema.isUUID());

export const PortfolioNameSchema = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200));

export const HoldingSchema = Schema.Struct({
  symbol: MarketSymbolSchema,
  weight: Schema.Finite.check(Schema.makeFilter((weight) => weight !== 0 || "Weight must be non-zero")),
});
export type Holding = typeof HoldingSchema.Type;

export const NewSnapshotSchema = Schema.Struct({
  holdingsDate: MarketDateSchema,
  holdings: Schema.Array(HoldingSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_SNAPSHOT_HOLDINGS),
    Schema.makeFilter((holdings) =>
      new Set(holdings.map((holding) => holding.symbol)).size === holdings.length ||
      "Each symbol can appear only once",
    ),
  ),
});
export type NewSnapshot = typeof NewSnapshotSchema.Type;

export const CreatePortfolioSchema = Schema.Struct({
  name: PortfolioNameSchema,
  snapshot: Schema.optionalKey(NewSnapshotSchema),
});
export type CreatePortfolio = typeof CreatePortfolioSchema.Type;

export const RenamePortfolioSchema = Schema.Struct({ name: PortfolioNameSchema });

export interface PortfolioSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly snapshotCount: number;
  readonly latestHoldingsDate: string | null;
}

export interface Snapshot {
  readonly holdingsDate: string;
  readonly createdAt: string;
  readonly holdings: readonly Holding[];
}

export interface Portfolio {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Oldest first. */
  readonly snapshots: readonly Snapshot[];
}

/** A portfolio as the calculation engine takes it in run and ad hoc requests. */
export interface EnginePortfolio {
  readonly id: string;
  readonly name: string;
  readonly snapshots: readonly { readonly holdingsDate: string; readonly holdings: readonly Holding[] }[];
}

export class PortfolioError extends Schema.TaggedError<PortfolioError>()("PortfolioError", {
  kind: Schema.Literals(["database", "not_found", "conflict", "untracked_symbols"]),
  message: Schema.String,
  /** The untracked symbols, for `untracked_symbols`. */
  symbols: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

/**
 * Portfolios and their holdings snapshots. Every held symbol is a tracked
 * `prices_eod` symbol (disabled ones count) and a portfolio has at most one
 * snapshot per holdings date. Snapshots are added or deleted, never edited.
 */
export class Portfolios extends Context.Service<
  Portfolios,
  {
    /** Every portfolio, by name. */
    readonly list: () => Effect.Effect<readonly PortfolioSummary[], PortfolioError>;
    readonly get: (id: string) => Effect.Effect<Portfolio, PortfolioError>;
    readonly create: (input: CreatePortfolio, id: string, now: string) => Effect.Effect<Portfolio, PortfolioError>;
    readonly rename: (id: string, name: string, now: string) => Effect.Effect<Portfolio, PortfolioError>;
    /** Delete a portfolio and its snapshots. */
    readonly remove: (id: string) => Effect.Effect<void, PortfolioError>;
    readonly addSnapshot: (id: string, snapshot: NewSnapshot, now: string) => Effect.Effect<Snapshot, PortfolioError>;
    readonly removeSnapshot: (id: string, holdingsDate: string, now: string) => Effect.Effect<void, PortfolioError>;
    /** A portfolio with the snapshots dated on or before `asOf`, for the engine. */
    readonly forEngine: (id: string, asOf: string) => Effect.Effect<EnginePortfolio, PortfolioError>;
  }
>()("data-service/Portfolios") {}
