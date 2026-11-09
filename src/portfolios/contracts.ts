/**
 * Portfolio request schemas and calculation input projections. Validation
 * here establishes value shape; the store enforces tracked-symbol, snapshot
 * date and managed-portfolio rules. Response-only types live in `views.ts`.
 */

import { Schema } from "effect";

import { MarketDateSchema, MarketSymbolSchema } from "$/market-data/schemas";

/** The holdings date of a single-asset portfolio's only snapshot. */
export const SINGLE_ASSET_HOLDINGS_DATE = "1900-01-01";

/** Most holdings one snapshot can have. */
export const MAX_SNAPSHOT_HOLDINGS = 5000;

/**
 * UUID identifying a saved portfolio. Used in portfolio routes and calculation
 * selections; validates format without checking that the portfolio exists.
 */
export const PortfolioIdSchema = Schema.String.check(Schema.isUUID());

/**
 * Trimmed display name used when creating or renaming a portfolio. Identity
 * comes from the portfolio ID, so callers must not resolve portfolios by name.
 */
export const PortfolioNameSchema = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
);

/**
 * One portfolio exposure: a tracked-symbol identifier and a finite, non-zero
 * weight. Negative weights and totals other than one are allowed; whether the
 * symbol is tracked is checked by the portfolio operation/store.
 */
export const HoldingSchema = Schema.Struct({
  symbol: MarketSymbolSchema,
  weight: Schema.Finite.check(
    Schema.makeFilter((weight) => weight !== 0 || "Weight must be non-zero"),
  ),
});

/**
 * Decoded symbol/weight pair used in snapshots and engine requests. This is
 * numeric domain input; the browser's editable row keeps its weight as text.
 */
export type Holding = typeof HoldingSchema.Type;

/**
 * A complete snapshot's exposures, with at least one holding and no repeated
 * symbols. Used for saved snapshots and ad hoc holdings; does not normalize weights.
 */
export const HoldingsSchema = Schema.Array(HoldingSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SNAPSHOT_HOLDINGS),
  Schema.makeFilter(
    (holdings) =>
      new Set(holdings.map((holding) => holding.symbol)).size ===
        holdings.length || "Each symbol can appear only once",
  ),
);

/**
 * Input for adding holdings effective at the close of `holdingsDate`. It
 * represents the whole holdings set from that date until the next snapshot,
 * not a trade/delta; storage rejects an already occupied date.
 */
export const NewSnapshotSchema = Schema.Struct({
  holdingsDate: MarketDateSchema,
  holdings: HoldingsSchema,
});

/**
 * Decoded, complete dated holdings input accepted when creating a portfolio
 * or adding a snapshot. The store supplies `createdAt` in the returned view.
 */
export type NewSnapshot = typeof NewSnapshotSchema.Type;

/**
 * HTTP input for creating a user-managed portfolio, optionally with its first
 * snapshot. Single-asset portfolios are created by symbol registration instead.
 */
export const CreatePortfolioSchema = Schema.Struct({
  name: PortfolioNameSchema,
  snapshot: Schema.optionalKey(NewSnapshotSchema),
});

/**
 * Decoded creation input consumed by `Portfolios.create`. A portfolio without
 * an initial snapshot can be configured now and given holdings later.
 */
export type CreatePortfolio = typeof CreatePortfolioSchema.Type;

/**
 * HTTP input for changing a portfolio's display name. Does not change its ID
 * or holdings; the store rejects renaming a managed single-asset portfolio.
 */
export const RenamePortfolioSchema = Schema.Struct({
  name: PortfolioNameSchema,
});

export type * from "$/portfolios/views";

/**
 * Saved portfolio projected into the engine request format. Load with
 * `Portfolios.forEngine(id, asOf)` to include only snapshots at/before the cutoff.
 * An empty selection is possible; the caller handles it before sending to Python.
 */
export interface EnginePortfolio {
  readonly id: string;
  readonly name: string;
  readonly snapshots: readonly {
    readonly holdingsDate: string;
    readonly holdings: readonly Holding[];
  }[];
}

/**
 * Expected failure when reading/changing portfolios or preparing them for a
 * calculation. `symbols` identifies untracked exposures; `calculations` explains
 * a deletion conflict. The HTTP adapter maps these reasons to client responses.
 */
export class PortfolioError extends Schema.TaggedError<PortfolioError>()(
  "PortfolioError",
  {
    /** `no_holdings`: no snapshot on or before the as-of date of a calculation. */
    kind: Schema.Literals([
      "database",
      "not_found",
      "conflict",
      "untracked_symbols",
      "no_holdings",
    ]),
    message: Schema.String,
    /** The untracked symbols, for `untracked_symbols`. */
    symbols: Schema.optionalKey(Schema.Array(Schema.String)),
    /** The calculations using a portfolio that can't be deleted, for `conflict`. */
    calculations: Schema.optionalKey(
      Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    ),
  },
) {}
