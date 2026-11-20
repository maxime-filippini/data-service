import { Effect, Schema } from "effect";

import { Portfolios } from "$/portfolios/store";

import {
  assetSubjectsContract,
  dateContract,
  portfolioHoldingsContract,
  portfolioSubjectContract,
} from "./contract";
import { defineStepType, terminal, transient } from "./step-type";

export const loadPortfolioHoldings = defineStepType({
  type: "portfolio-holdings",
  description: "Read the portfolio holdings effective at the requested date",
  scopes: ["portfolio"],
  params: Schema.Struct({}),
  inputs: {
    portfolio: {
      contract: portfolioSubjectContract,
      description: "The portfolio to read",
    },
    processingDate: {
      contract: dateContract,
      description: "The date for which to resolve holdings",
    },
  },
  outputs: {
    holdingsDate: {
      contract: dateContract,
      description: "The snapshot's effective date",
    },
    holdings: {
      contract: portfolioHoldingsContract,
      description: "Asset symbols and weights from the snapshot",
    },
    assets: {
      contract: assetSubjectsContract,
      description: "The assets whose prices are required",
    },
  },
  implementation: ({ inputs }) =>
    Portfolios.use((portfolios) =>
      portfolios.holdingsAt(inputs.portfolio.id, inputs.processingDate),
    ).pipe(
      Effect.mapError((error) =>
        error.kind === "database"
          ? transient(error.message)
          : terminal(error.message),
      ),
      Effect.map(({ holdingsDate, holdings }) => ({
        holdingsDate,
        holdings,
        assets: holdings.map(({ symbol }) => ({
          kind: "asset" as const,
          symbol,
        })),
      })),
    ),
});
