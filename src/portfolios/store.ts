import { Context, type Effect } from "effect";

import type {
  CreatePortfolio,
  EnginePortfolio,
  NewSnapshot,
  Portfolio,
  PortfolioError,
  PortfolioSummary,
  Snapshot,
} from "./contracts";

/**
 * Injectable portfolio persistence and engine-projection interface. Operations
 * obtain it with `yield* Portfolios`; `D1PortfoliosLive` enforces tracked symbols,
 * unique snapshot dates and managed single-asset protections. Use `get` for
 * presentation and `forEngine` for cutoff-filtered calculation input. Snapshot
 * changes replace complete dated sets by deletion/addition, not individual trades.
 */
export class Portfolios extends Context.Service<
  Portfolios,
  {
    /** Every portfolio, by name. */
    readonly list: () => Effect.Effect<
      readonly PortfolioSummary[],
      PortfolioError
    >;
    readonly get: (id: string) => Effect.Effect<Portfolio, PortfolioError>;
    readonly create: (
      input: CreatePortfolio,
      id: string,
      now: string,
    ) => Effect.Effect<Portfolio, PortfolioError>;
    readonly rename: (
      id: string,
      name: string,
      now: string,
    ) => Effect.Effect<Portfolio, PortfolioError>;
    /** Delete a portfolio and its snapshots. A conflict if a calculation uses it. */
    readonly remove: (id: string) => Effect.Effect<void, PortfolioError>;
    readonly addSnapshot: (
      id: string,
      snapshot: NewSnapshot,
      now: string,
    ) => Effect.Effect<Snapshot, PortfolioError>;
    readonly removeSnapshot: (
      id: string,
      holdingsDate: string,
      now: string,
    ) => Effect.Effect<void, PortfolioError>;
    /** Fails with `untracked_symbols` unless every symbol is a tracked `prices_eod` symbol. */
    readonly requireTracked: (
      symbols: readonly string[],
    ) => Effect.Effect<void, PortfolioError>;
    /** A portfolio with the snapshots dated on or before `asOf`, for the engine. */
    readonly forEngine: (
      id: string,
      asOf: string,
    ) => Effect.Effect<EnginePortfolio, PortfolioError>;
  }
>()("data-service/Portfolios") {}
