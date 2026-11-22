import { Effect, Schema } from "effect";

import { AssetStore } from "$/assets/store";
import { nowIso } from "$/clock";
import { type MarketDataError, PriceProvider } from "$/market-data";
import { MarketDateSchema } from "$/market-data/schemas";
import { PriceProviders } from "$/market-data/sources";
import { RunArtifactStore, runArtifactId } from "$/workflows/artifacts";

import {
  assetSubjectContract,
  dateContract,
  rawPricesEodContract,
} from "./contract";
import { defineStepType, terminal, transient } from "./step-type";

/** The raw artifact's envelope version, as in legacy raw storage. */
const RAW_ENVELOPE_VERSION = 1;

/**
 * Provider failures that a retry can fix: the request failed (network or
 * HTTP status). A misconfigured provider or a response that fails raw-data
 * validation fails the same way again.
 */
const providerFailure = (error: MarketDataError) =>
  error.kind === "request" || error.kind === "storage"
    ? transient(error.message)
    : terminal(error.message);

/**
 * Download an asset's end-of-day prices from its provider and keep the raw
 * response as a run artifact. The asset's provider and backfill start date
 * are its own settings; `startDate` overrides the start for this workflow.
 * The provider adapter validates every row before anything is written. The
 * artifact's ID is fixed by the run and step, so a retried attempt replaces
 * the same object.
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
    asset: {
      contract: assetSubjectContract,
      description: "The asset to download",
    },
    throughDate: {
      contract: dateContract,
      description: "The last date to request, usually the processing date",
    },
  },
  outputs: {
    raw: {
      contract: rawPricesEodContract,
      description: "The raw provider response, stored under the run",
    },
  },
  implementation: ({ params, inputs, execution }) =>
    Effect.gen(function* () {
      const symbol = inputs.asset.symbol;
      const asset = yield* AssetStore.use((assets) => assets.get(symbol)).pipe(
        Effect.mapError((error) =>
          error.kind === "not_found"
            ? terminal(error.message)
            : transient(error.message),
        ),
      );
      const range = {
        from: params.startDate ?? asset.backfillStartDate,
        to: inputs.throughDate,
      };
      if (range.from > range.to)
        return yield* terminal(
          `The start date ${range.from} is after the through date ${range.to}`,
        );

      const sources = yield* PriceProviders;
      const entries = yield* PriceProvider.use((source) =>
        source.retrieveDaily(symbol, range),
      ).pipe(
        Effect.provide(sources.sourceFor(asset.provider)),
        Effect.mapError(providerFailure),
      );

      const raw = {
        id: runArtifactId({
          runId: execution.runId,
          stepId: execution.stepId,
          name: "raw",
          format: "json",
        }),
        format: "json",
        schema: "raw-prices-eod/v1",
      } as const;
      const receivedAt = yield* nowIso;
      const envelope = {
        version: RAW_ENVELOPE_VERSION,
        runId: execution.runId,
        dataset: "prices_eod",
        provider: asset.provider,
        symbol,
        requestedRange: range,
        receivedAt,
        entries,
      };
      yield* RunArtifactStore.use((artifacts) =>
        artifacts.put(raw.id, JSON.stringify(envelope), "application/json"),
      ).pipe(
        Effect.mapError((error) =>
          error.kind === "storage"
            ? transient(error.message)
            : terminal(error.message),
        ),
      );
      return { raw };
    }),
});
