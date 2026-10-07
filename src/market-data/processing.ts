import { Effect } from "effect";

import {
  type CompleteProcessingJob,
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

export interface StartSymbolProcessingJob {
  readonly jobId: string;
  readonly startedAt: string;
}

/** Claim a queued job before the processor reads or writes canonical data. */
export const startSymbolProcessingJob = Effect.fn(
  "MarketData.startSymbolProcessingJob",
)(function* (input: StartSymbolProcessingJob) {
  const controlPlane = yield* MarketDataControlPlane;
  return yield* controlPlane.claimProcessingJob(input.jobId, input.startedAt);
});

/** Record a successful canonical Parquet write and release the symbol lock. */
export const completeSymbolProcessingJob = Effect.fn(
  "MarketData.completeSymbolProcessingJob",
)(function* (input: CompleteProcessingJob) {
  const controlPlane = yield* MarketDataControlPlane;
  return yield* controlPlane.completeProcessingJob(input);
});

export interface FailSymbolProcessingJob {
  readonly jobId: string;
  readonly message: string;
  readonly completedAt: string;
}

/** Release the symbol lock after a processor failure, preserving the error. */
export const failSymbolProcessingJob = Effect.fn(
  "MarketData.failSymbolProcessingJob",
)(function* (input: FailSymbolProcessingJob) {
  const controlPlane = yield* MarketDataControlPlane;
  return yield* controlPlane.failProcessingJob(
    input.jobId,
    input.message,
    input.completedAt,
  );
});
