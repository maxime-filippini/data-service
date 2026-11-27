import { Effect } from "effect";

import { PythonOperations } from "$/operations/client";
import { PortfolioVolatilityParams } from "$/operations/contracts.generated";

import {
  dateContract,
  portfolioHoldingsContract,
  PortfolioHoldingsArtifactSchema,
  portfolioVolatilityDataContract,
  portfolioVolatilitySummaryContract,
  publishedAssetPricesContract,
  PublishedAssetPricesArtifactSchema,
} from "./contract";
import { requireJsonArtifact } from "./json-artifact";
import { defineStepType, StepFailure, terminal } from "./step-type";

export const calculatePortfolioVolatility = defineStepType({
  type: "calculate-portfolio-volatility",
  description:
    "Apply the effective holdings weights to historical returns and calculate annualised ex-ante volatility in Python",
  scopes: ["portfolio"],
  params: PortfolioVolatilityParams,
  inputs: {
    holdings: {
      contract: portfolioHoldingsContract,
      description:
        "The resolved holdings artifact with the snapshot's symbols and weights",
    },
    publications: {
      contract: publishedAssetPricesContract,
      description:
        "The artifact listing the current asset price publications for the processing date",
    },
    processingDate: {
      contract: dateContract,
      description: "The last date of prices the calculation may use",
    },
  },
  outputs: {
    data: {
      contract: portfolioVolatilityDataContract,
      description: "The volatility result as a Parquet run artifact",
    },
    summary: {
      contract: portfolioVolatilitySummaryContract,
      description: "The volatility value, return window and holdings date",
    },
  },
  implementation: ({ params, inputs, context, execution }) =>
    Effect.gen(function* () {
      if (context.subject.kind !== "portfolio")
        return yield* terminal("Volatility requires a portfolio subject");
      if (inputs.processingDate !== context.processingDate)
        return yield* terminal("Volatility must use the run's processing date");
      const portfolioId = context.subject.id;
      const snapshot = yield* requireJsonArtifact(
        inputs.holdings,
        PortfolioHoldingsArtifactSchema,
        "holdings",
      );
      if (
        snapshot.portfolio.id !== portfolioId ||
        snapshot.processingDate !== inputs.processingDate
      )
        return yield* terminal(
          "The holdings artifact does not match the portfolio and processing date",
        );
      const publications = yield* requireJsonArtifact(
        inputs.publications,
        PublishedAssetPricesArtifactSchema,
        "publications",
      );
      return yield* PythonOperations.use((python) =>
        python.invoke("calculate-portfolio-volatility", {
          execution: { runId: execution.runId, stepId: execution.stepId },
          inputs: {
            portfolioId,
            processingDate: inputs.processingDate,
            holdingsDate: snapshot.holdingsDate,
            holdings: snapshot.holdings,
            publications,
          },
          params,
        }),
      ).pipe(
        Effect.mapError(
          (error) =>
            new StepFailure({
              retry: error.kind === "transient",
              message: error.message,
            }),
        ),
      );
    }),
});
