import { Effect } from "effect";

import { PythonOperations } from "$/operations/client";
import { PortfolioVolatilityParams } from "$/operations/contracts.generated";

import {
  dateContract,
  portfolioHoldingsContract,
  portfolioVolatilityDataContract,
  portfolioVolatilitySummaryContract,
  publishedAssetPricesContract,
} from "./contract";
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
        "The effective holdings snapshot's asset symbols and weights",
    },
    holdingsDate: {
      contract: dateContract,
      description: "The effective date of the holdings snapshot",
    },
    publications: {
      contract: publishedAssetPricesContract,
      description:
        "The current asset price publications for the processing date",
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
  implementation: ({ params, inputs, context, execution }) => {
    if (context.subject.kind !== "portfolio")
      return Effect.fail(terminal("Volatility requires a portfolio subject"));
    if (inputs.processingDate !== context.processingDate)
      return Effect.fail(
        terminal("Volatility must use the run's processing date"),
      );
    const portfolioId = context.subject.id;
    return PythonOperations.use((python) =>
      python.invoke("calculate-portfolio-volatility", {
        execution: { runId: execution.runId, stepId: execution.stepId },
        inputs: { ...inputs, portfolioId },
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
  },
});
