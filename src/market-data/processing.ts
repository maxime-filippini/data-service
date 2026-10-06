import { Effect } from "effect";

import {
  MarketDataControlPlane,
  type ProcessingJobMode,
} from "$/market-data/control-plane";

export const canonicalMarketDataKey = (symbol: string) =>
  `dataset=prices_eod/symbol=${symbol}/data.parquet`;

export interface PrepareSymbolProcessingJob {
  readonly jobId: string;
  readonly symbol: string;
  readonly mode: ProcessingJobMode;
  readonly transformVersion: string;
  readonly createdAt: string;
}

/** Freeze the exact ingestion runs a Python processing attempt must consume. */
export const prepareSymbolProcessingJob = Effect.fn(
  "MarketData.prepareSymbolProcessingJob",
)(function* (input: PrepareSymbolProcessingJob) {
  const controlPlane = yield* MarketDataControlPlane;

  return yield* controlPlane.createProcessingJob({
    jobId: input.jobId,
    symbol: input.symbol,
    mode: input.mode,
    canonicalKey: canonicalMarketDataKey(input.symbol),
    transformVersion: input.transformVersion,
    createdAt: input.createdAt,
  });
});

/** Resolve the complete, immutable run selection for a processor. */
export const readSymbolProcessingJob = Effect.fn(
  "MarketData.readSymbolProcessingJob",
)(function* (jobId: string) {
  const controlPlane = yield* MarketDataControlPlane;
  return yield* controlPlane.readProcessingJob(jobId);
});
