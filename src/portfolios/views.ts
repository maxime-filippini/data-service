// Portfolios as the API returns them. This file has no imports so the
// dashboard app can import its types directly.

export interface HoldingView {
  readonly symbol: string;
  readonly weight: number;
}

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

export interface Snapshot {
  readonly holdingsDate: string;
  readonly createdAt: string;
  readonly holdings: readonly HoldingView[];
}

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

/** A calculation that uses a portfolio, in the `409` for deleting it. */
export interface PortfolioUser {
  readonly id: string;
  readonly name: string;
}
