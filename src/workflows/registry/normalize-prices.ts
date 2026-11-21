import { Effect } from "effect";

import { PythonOperations } from "$/operations/client";
import { NormalizePricesParams } from "$/operations/contracts.generated";

import { pricesEodContract, rawPricesEodContract } from "./contract";
import { defineStepType, StepFailure } from "./step-type";

/**
 * Normalize a raw end-of-day price download in the Python service (operation
 * `normalize-prices-eod`). The step passes its run/step identity and the
 * raw artifact reference; Python writes `runs/<runId>/<stepId>/prices.parquet`
 * and returns its reference. The location is fixed by the run and step, so
 * a retry after a lost response rewrites the same object. Params and the
 * request/response are the contracts generated from Python's Pydantic models.
 */
export const normalizePrices = defineStepType({
  type: "normalize-prices",
  description:
    "Normalize a raw end-of-day price download into prices_eod Parquet in the Python service",
  scopes: ["asset"],
  params: NormalizePricesParams,
  inputs: {
    raw: {
      contract: rawPricesEodContract,
      description: "The raw provider response, from a download step",
    },
  },
  outputs: {
    prices: {
      contract: pricesEodContract,
      description: "Date-sorted prices_eod rows, stored under the run",
    },
  },
  implementation: ({ params, inputs, execution }) =>
    PythonOperations.use((python) =>
      python.invoke("normalize-prices-eod", {
        execution: { runId: execution.runId, stepId: execution.stepId },
        inputs: { raw: inputs.raw },
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
    ),
});
