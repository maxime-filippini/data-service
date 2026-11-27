import { Effect, Schema } from "effect";

import { Portfolios } from "$/portfolios/store";

import {
  dateContract,
  PortfolioHoldingsArtifactSchema,
  portfolioHoldingsContract,
  portfolioSubjectContract,
} from "./contract";
import {
  jsonArtifactReference,
  readJsonArtifact,
  writeJsonArtifact,
} from "./json-artifact";
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
      description: "The resolved snapshot, stored under the run as JSON",
    },
  },
  implementation: ({ inputs, execution }) =>
    Effect.gen(function* () {
      const reference = jsonArtifactReference(
        execution,
        "holdings",
        "portfolio-holdings/v1",
      );
      const stored = yield* readJsonArtifact(
        reference,
        PortfolioHoldingsArtifactSchema,
      );
      if (stored !== null) {
        if (
          stored.portfolio.id !== inputs.portfolio.id ||
          stored.processingDate !== inputs.processingDate
        )
          return yield* terminal(
            "The stored holdings do not match the portfolio and processing date",
          );
        return { holdingsDate: stored.holdingsDate, holdings: reference };
      }
      const { holdingsDate, holdings } = yield* Portfolios.use((portfolios) =>
        portfolios.holdingsAt(inputs.portfolio.id, inputs.processingDate),
      ).pipe(
        Effect.mapError((error) =>
          error.kind === "database"
            ? transient(error.message)
            : terminal(error.message),
        ),
      );
      yield* writeJsonArtifact(reference, PortfolioHoldingsArtifactSchema, {
        portfolio: inputs.portfolio,
        processingDate: inputs.processingDate,
        holdingsDate,
        holdings,
      });
      return { holdingsDate, holdings: reference };
    }),
});
