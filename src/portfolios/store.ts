import { Context, type Effect } from "effect";

import type {
  CreatePortfolio,
  NewSnapshot,
  Portfolio,
  PortfolioError,
  PortfolioSummary,
  Snapshot,
} from "./contracts";

/**
 * Injectable portfolio persistence interface. Operations obtain it with
 * `yield* Portfolios`; `D1PortfoliosLive` enforces asset references, unique
 * snapshot dates and active-run deletion guards while retaining read
 * compatibility for pre-cutover `portfolio_holdings` rows. Snapshot changes
 * replace complete dated sets by deletion/addition, not individual trades.
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
    /** The snapshot effective at the close of `date`. */
    readonly holdingsAt: (
      id: string,
      date: string,
    ) => Effect.Effect<Snapshot, PortfolioError>;
    /** The snapshot effective at `from`, if any, and changes through `through`. */
    readonly holdingsBetween: (
      id: string,
      from: string,
      through: string,
    ) => Effect.Effect<readonly Snapshot[], PortfolioError>;
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
    /** Delete configuration. An active workflow run blocks deletion. */
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
  }
>()("data-service/Portfolios") {}
