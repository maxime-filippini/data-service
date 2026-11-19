import { Effect, Schema } from "effect";

import { Portfolios } from "$/portfolios/store";

import {
  assetSubjects,
  date,
  portfolioHoldings,
  portfolioSubject,
} from "./contract";
import { defineStepType, terminal, transient } from "./step-type";

export const loadPortfolioHoldings = defineStepType({
  type: "portfolio-holdings",
  description: "Read the portfolio holdings effective at the requested date",
  scopes: ["portfolio"],
  params: Schema.Struct({}),
  inputs: {
    portfolio: {
      contract: portfolioSubject,
      description: "The portfolio to read",
    },
    processingDate: {
      contract: date,
      description: "The date for which to resolve holdings",
    },
  },
  outputs: {
    holdingsDate: {
      contract: date,
      description: "The snapshot's effective date",
    },
    holdings: {
      contract: portfolioHoldings,
      description: "Asset symbols and weights from the snapshot",
    },
    assets: {
      contract: assetSubjects,
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
