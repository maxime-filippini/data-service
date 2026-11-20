import { Effect, Schema } from "effect";

import { publishedDatasetKey } from "$/datasets/contracts";
import { DatasetPublicationStore, DatasetObjectStore } from "$/datasets/store";
import { WorkflowIdSchema } from "$/workflows/contracts";
import type { MissingDependency } from "$/workflows/runs/contracts";

import {
  assetSubjectsContract,
  dateContract,
  publishedAssetPricesContract,
} from "./contract";
import { asTransient, defineStepType } from "./step-type";

const DEFAULT_TIMEOUT_SECONDS = 2 * 60 * 60;

const timeoutSeconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(DEFAULT_TIMEOUT_SECONDS),
).annotate({
  description: "Wait timeout in seconds, up to two hours (the default)",
});

export const waitForAssetPublications = defineStepType({
  type: "wait-for-asset-publications",
  description:
    "Wait for current asset prices from successful runs of the upstream workflow for the requested date",
  scopes: ["portfolio"],
  params: Schema.Struct({
    workflowId: WorkflowIdSchema.annotate({
      description: "The upstream asset workflow ID",
    }),
    timeoutSeconds: Schema.optionalKey(timeoutSeconds),
  }),
  inputs: {
    assets: {
      contract: assetSubjectsContract,
      description: "All assets whose prices must be ready",
    },
    processingDate: {
      contract: dateContract,
      description: "The required upstream processing date",
    },
  },
  outputs: {
    publications: {
      contract: publishedAssetPricesContract,
      description: "The matching current price publications",
    },
  },
  wait: {
    timeoutMs: (params) =>
      (params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    check: ({ params, inputs }, deadline) =>
      Effect.gen(function* () {
        const checks = yield* DatasetPublicationStore.use((publications) =>
          publications.checkAssetPrices({
            workflowId: params.workflowId,
            processingDate: inputs.processingDate,
            symbols: inputs.assets.map(({ symbol }) => symbol),
            deadline,
          }),
        );
        const missing: MissingDependency[] = [];
        const publications = [];
        const objects = yield* DatasetObjectStore;
        for (const { symbol, succeeded, publication } of checks) {
          const subject = { kind: "asset", symbol } as const;
          if (!succeeded) {
            missing.push({ symbol, reason: "no-successful-run" });
          } else if (publication === null) {
            missing.push({ symbol, reason: "no-publication" });
          } else if (!publication.matches) {
            missing.push({ symbol, reason: "publication-does-not-match" });
          } else {
            const etag = yield* objects.etag(
              publishedDatasetKey("prices_eod", subject),
            );
            if (etag === null || etag !== publication.etag) {
              missing.push({
                symbol,
                reason: "publication-object-does-not-match",
              });
            } else {
              publications.push({
                dataset: "prices_eod" as const,
                subject,
                processingDate: inputs.processingDate,
                workflowId: params.workflowId,
                runId: publication.runId,
              });
            }
          }
        }
        return missing.length === 0
          ? { ready: true as const, outputs: { publications } }
          : { ready: false as const, missing };
      }).pipe(asTransient),
  },
});
