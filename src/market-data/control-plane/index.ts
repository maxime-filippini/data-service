import { Context, Effect, Schema } from "effect";

import type { Dataset, DateRange, Provider } from "$/market-data/schemas";

/**
 * Receipt returned after storing an immutable raw ingestion response in R2.
 * Persist it with the ingestion run so a processing manifest can identify the
 * expected object contents; `observedRange` is absent for an empty response.
 */
export interface RawObject {
  readonly key: string;
  readonly etag: string;
  readonly rowCount: number;
  readonly observedRange?: DateRange;
}

/**
 * Claim request passed to the run store before provider I/O. Identifies the
 * download and its inclusive requested range; `staleBefore` allows an abandoned
 * fetching record to be failed before attempting the per-symbol claim.
 */
export interface StartIngestionRun {
  readonly runId: string;
  readonly dataset: Dataset;
  readonly symbol: string;
  readonly provider: Provider;
  readonly requestedRange: DateRange;
  readonly createdAt: string;
  /** A `fetching` run for the same symbol created before this is assumed dead and failed. */
  readonly staleBefore: string;
}

/**
 * Commit information passed to the run store after raw storage succeeds.
 * Associates the R2 receipt with the run; this completes downloading only,
 * while a separate processing job later builds canonical Parquet.
 */
export interface CompleteIngestionRun {
  readonly runId: string;
  readonly object: RawObject;
  readonly completedAt: string;
}

/**
 * Worker-to-processor `/jobs` payload pinning one completed raw ingestion to
 * a canonical Parquet rebuild. The processor checks its envelope and ETag
 * against `input`, writes `outputKey`, and returns an ETag; the Worker owns D1 state.
 */
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

/**
 * Expected persistence failure while claiming or updating ingestion runs and
 * processing jobs. Optional IDs let callers correlate the failure with durable
 * work; queue consumers use this category when deciding to retry delivery.
 */
export class ControlPlaneError extends Schema.TaggedError<ControlPlaneError>()(
  "ControlPlaneError",
  {
    message: Schema.String,
    runId: Schema.optionalKey(Schema.String),
    jobId: Schema.optionalKey(Schema.String),
  },
) {}

/**
 * Short form for a store operation with a typed control-plane failure.
 * Dependencies are already captured by the supplied persistence adapter.
 */
type Op<A = void> = Effect.Effect<A, ControlPlaneError>;

/**
 * Injectable state store for ingestion runs and processing jobs. Used by
 * queue orchestration to claim work and record outcomes, keeping state in D1
 * while provider/R2/container I/O happens outside this interface. Job creation
 * selects an eligible completed run; each manifest pins that run for processing.
 */
export class MarketDataControlPlane extends Context.Service<
  MarketDataControlPlane,
  {
    /** Record a new `fetching` run; false if the symbol already has one in progress. */
    readonly startIngestionRun: (input: StartIngestionRun) => Op<boolean>;
    readonly completeIngestionRun: (input: CompleteIngestionRun) => Op;
    readonly failIngestionRun: (
      runId: string,
      message: string,
      at: string,
    ) => Op;

    /** Queue a job for every symbol whose latest completed run has never been processed. */
    readonly createPendingJobs: (createdAt: string) => Op<number>;
    /**
     * Queue a job for one run if it is still the symbol's latest completed run
     * and the symbol has no active job. Returns the new job ID, if any.
     */
    readonly createJobForRun: (
      runId: string,
      createdAt: string,
    ) => Op<string | undefined>;
    /** Fail jobs stuck in `processing` since before the cutoff, releasing their lock. */
    readonly failStaleJobs: (startedBefore: string, at: string) => Op<number>;
    readonly listQueuedJobIds: () => Op<readonly string[]>;

    /** Atomically move a queued job to `processing`; undefined if it was not queued. */
    readonly claimJob: (
      jobId: string,
      startedAt: string,
    ) => Op<ProcessingManifest | undefined>;
    readonly completeJob: (jobId: string, outputEtag: string, at: string) => Op;
    readonly failJob: (jobId: string, message: string, at: string) => Op;
    /** Return a claimed job to the queue after a delivery failure. */
    readonly releaseJob: (jobId: string) => Op;
  }
>()("data-service/MarketDataControlPlane") {}
