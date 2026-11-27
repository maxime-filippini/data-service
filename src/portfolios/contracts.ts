/**
 * Portfolio request schemas and errors. Validation here establishes value
 * shape; the store enforces asset references, snapshot date and managed-portfolio
 * rules. Response-only types live in `views.ts`.
 */

import { Schema } from "effect";

import { MarketDateSchema, MarketSymbolSchema } from "$/market-data/schemas";

/** Historical holdings date of a generated single-asset portfolio's only snapshot. */
export const SINGLE_ASSET_HOLDINGS_DATE = "1900-01-01";

/** Most holdings one snapshot can have. */
export const MAX_SNAPSHOT_HOLDINGS = 5000;

/**
 * UUID identifying a saved portfolio. Used in portfolio routes and workflow
 * assignments; validates format without checking that the portfolio exists.
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
 * One portfolio exposure: an asset symbol and a finite, non-zero weight.
 * Negative weights and totals other than one are allowed. The portfolio
 * store validates asset references.
 */
export const HoldingSchema = Schema.Struct({
  symbol: MarketSymbolSchema,
  weight: Schema.Finite.check(
    Schema.makeFilter((weight) => weight !== 0 || "Weight must be non-zero"),
  ),
});

/**
 * A complete snapshot's exposures, with at least one holding and no repeated
 * symbols. Weights are not normalized here.
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
 * HTTP input for creating a portfolio, optionally with its first snapshot.
 */
export const CreatePortfolioSchema = Schema.Struct({
  name: PortfolioNameSchema,
  snapshot: Schema.optionalKey(NewSnapshotSchema),
});

/**
 * HTTP input for changing a portfolio's display name. Does not change its ID
 * or holdings; the store rejects renaming a historical managed single-asset portfolio.
 */
export const RenamePortfolioSchema = Schema.Struct({
  name: PortfolioNameSchema,
});

/**
 * Decoded symbol/weight pair used in snapshots. This is numeric domain input;
 * the browser's editable row keeps its weight as text.
 */
export type Holding = typeof HoldingSchema.Type;

/**
 * Decoded, complete dated holdings input accepted when creating a portfolio
 * or adding a snapshot. The store supplies `createdAt` in the returned view.
 */
export type NewSnapshot = typeof NewSnapshotSchema.Type;

/**
 * Decoded creation input consumed by `Portfolios.create`. A portfolio without
 * an initial snapshot can be configured now and given holdings later.
 */
export type CreatePortfolio = typeof CreatePortfolioSchema.Type;

export type * from "$/portfolios/views";

/**
 * Expected failure when reading/changing portfolios. `symbols` identifies
 * unknown assets. The HTTP adapter maps these reasons to client responses.
 */
export class PortfolioError extends Schema.TaggedError<PortfolioError>()(
  "PortfolioError",
  {
    /** `no_holdings`: no snapshot on or before the requested date. */
    kind: Schema.Literals([
      "database",
      "not_found",
      "conflict",
      "untracked_symbols",
      "no_holdings",
    ]),
    message: Schema.String,
    /** Unknown asset symbols, for `untracked_symbols`. */
    symbols: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {}
