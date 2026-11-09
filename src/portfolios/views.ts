// Portfolios as the API returns them. This file has no imports so the
// dashboard app can import its types directly.

/**
 * Serialized exposure shown by portfolio pages and reused as numeric form
 * input. Weights may be negative and do not have to sum to one.
 */
export interface HoldingView {
  readonly symbol: string;
  readonly weight: number;
}

/**
 * List projection with snapshot counts/dates, avoiding the full holdings
 * history. `assetSymbol` marks a managed single-asset portfolio so the app can
 * show it as read-only; use `Portfolio` when actual snapshots are needed.
 */
export interface PortfolioSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The symbol a single-asset portfolio holds, null for other portfolios. */
  readonly assetSymbol: string | null;
  readonly snapshotCount: number;
  readonly latestHoldingsDate: string | null;
}

/**
 * One persisted complete holdings set, effective from its holdings-date close
 * until the next snapshot. `createdAt` is when it was saved, not its effective date.
 */
export interface Snapshot {
  readonly holdingsDate: string;
  readonly createdAt: string;
  readonly holdings: readonly HoldingView[];
}

/**
 * Detail projection containing the complete saved snapshot history, oldest
 * first. Used by portfolio pages; calculations use the cutoff-filtered
 * `EnginePortfolio` projection rather than this presentation shape.
 */
export interface Portfolio {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The symbol a single-asset portfolio holds, null for other portfolios. */
  readonly assetSymbol: string | null;
  /** Oldest first. */
  readonly snapshots: readonly Snapshot[];
}

/**
 * Minimal calculation reference returned with a portfolio deletion conflict.
 * Lets clients explain which saved calculations still depend on that portfolio.
 */
export interface PortfolioUser {
  readonly id: string;
  readonly name: string;
}
