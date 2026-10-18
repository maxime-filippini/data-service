import { Context, Effect, Schema } from "effect";

import type { Dataset, DateRange, Provider } from "$/market-data/schemas";

export interface RawObject {
  readonly key: string;
  readonly etag: string;
  readonly rowCount: number;
  readonly observedRange?: DateRange;
}

export interface StartIngestionRun {
  readonly runId: string;
  readonly dataset: Dataset;
  readonly symbol: string;
  readonly provider: Provider;
  readonly requestedRange: DateRange;
  readonly createdAt: string;
}

export interface CompleteIngestionRun {
  readonly runId: string;
  readonly object: RawObject;
  readonly completedAt: string;
}

/** Everything the processor needs to rebuild one canonical object. */
export interface ProcessingManifest {
  readonly jobId: string;
  readonly dataset: Dataset;
  readonly symbol: string;
  readonly outputKey: string;
  readonly input: {
    readonly runId: string;
    readonly provider: Provider;
    readonly requestedRange: DateRange;
    readonly key: string;
    readonly etag: string;
    readonly rowCount: number;
  };
}

export class ControlPlaneError extends Schema.TaggedError<ControlPlaneError>()(
  "ControlPlaneError",
  {
    message: Schema.String,
    runId: Schema.optionalKey(Schema.String),
    jobId: Schema.optionalKey(Schema.String),
  },
) {}

type Op<A = void> = Effect.Effect<A, ControlPlaneError>;

/**
 * D1-backed run and job state.
 *
 * Every job rebuilds a canonical object from the latest completed run, so
 * rerunning a job is always safe.
 */
export class MarketDataControlPlane extends Context.Service<
  MarketDataControlPlane,
  {
    readonly startIngestionRun: (input: StartIngestionRun) => Op;
    readonly completeIngestionRun: (input: CompleteIngestionRun) => Op;
    readonly failIngestionRun: (runId: string, message: string, at: string) => Op;

    /** Queue a job for every symbol whose latest completed run has never been processed. */
    readonly createPendingJobs: (createdAt: string) => Op<number>;
    /** Fail jobs stuck in `processing` since before the cutoff, releasing their lock. */
    readonly failStaleJobs: (startedBefore: string, at: string) => Op<number>;
    readonly listQueuedJobIds: () => Op<readonly string[]>;

    /** Atomically move a queued job to `processing`; undefined if it was not queued. */
    readonly claimJob: (jobId: string, startedAt: string) => Op<ProcessingManifest | undefined>;
    readonly completeJob: (jobId: string, outputEtag: string, at: string) => Op;
    readonly failJob: (jobId: string, message: string, at: string) => Op;
    /** Return a claimed job to the queue after a delivery failure. */
    readonly releaseJob: (jobId: string) => Op;
  }
>()("data-service/MarketDataControlPlane") {}
