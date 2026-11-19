import { Schema } from "effect";

import { MarketDateSchema } from "$/market-data/schemas";

import { assetSubject, date, rawPricesEod } from "./contract";
import { defineStepType } from "./step-type";

/**
 * Download an asset's end-of-day prices from its provider and keep the raw
 * response as a run artifact. The asset's provider and backfill start date
 * are its own settings; `startDate` overrides the start for this workflow.
 * Execution is wired by the executor (manual-download ticket).
 */
export const downloadPrices = defineStepType({
  type: "download-prices",
  description:
    "Download an asset's end-of-day prices from its provider through the throughDate, keeping the raw response as a run artifact",
  scopes: ["asset"],
  params: Schema.Struct({
    startDate: Schema.optionalKey(
      MarketDateSchema.annotate({
        description:
          "First date to request; defaults to the asset's backfill start date",
      }),
    ),
  }),
  inputs: {
    asset: { contract: assetSubject, description: "The asset to download" },
    throughDate: {
      contract: date,
      description: "The last date to request, usually the processing date",
    },
  },
  outputs: {
    raw: {
      contract: rawPricesEod,
      description: "The raw provider response, stored under the run",
    },
  },
});
