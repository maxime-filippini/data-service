import { Context, Effect, Schema } from "effect";

import type { DateRange } from "$/market-data/coverage";

export type IngestionRunStatus = "fetching" | "raw_complete" | "failed";
export type ProcessingJobMode = "merge" | "rebuild";
export type ProcessingJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export interface IngestionRun {
  readonly runId: string;
  readonly provider: string;
  readonly symbol: string;
  readonly requestedRange: DateRange;
  readonly status: IngestionRunStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface IngestionRunObject {
  readonly key: string;
  readonly etag: string;
  readonly observedRange?: DateRange;
  readonly rowCount: number;
}

export interface StartIngestionRun {
  readonly runId: string;
  readonly provider: string;
  readonly symbol: string;
  readonly requestedRange: DateRange;
  readonly createdAt: string;
}

export interface CompleteIngestionRun {
  readonly runId: string;
  readonly object: IngestionRunObject;
  readonly completedAt: string;
}

export interface CreateProcessingJob {
  readonly jobId: string;
  readonly symbol: string;
  readonly mode: ProcessingJobMode;
  readonly canonicalKey: string;
  readonly transformVersion: string;
  readonly createdAt: string;
}

export interface ProcessingJobRun {
  readonly runId: string;
  readonly provider: string;
  readonly requestedRange: DateRange;
  readonly precedence: number;
  readonly completedAt: string;
  readonly objects: readonly IngestionRunObject[];
}

export interface ProcessingJob {
  readonly jobId: string;
  readonly symbol: string;
  readonly mode: ProcessingJobMode;
  readonly canonicalKey: string;
  readonly expectedBaseEtag?: string;
  readonly transformVersion: string;
  readonly status: ProcessingJobStatus;
  readonly createdAt: string;
  readonly runs: readonly ProcessingJobRun[];
}

export interface CompleteProcessingJob {
  readonly jobId: string;
  readonly outputEtag: string;
  readonly completeThrough?: string;
  readonly completedAt: string;
}

export class MarketDataControlPlaneError extends Schema.TaggedError<MarketDataControlPlaneError>()(
  "MarketDataControlPlaneError",
  {
    kind: Schema.Literals(["database", "conflict", "not_found", "no_work"]),
    message: Schema.String,
    runId: Schema.optionalKey(Schema.String),
    jobId: Schema.optionalKey(Schema.String),
    symbol: Schema.optionalKey(Schema.String),
  },
) {}

/**
 * Mutable control-plane state for raw ingestion and canonical processing.
 *
 * A processing job freezes its run membership when it is created. New runs
 * arriving afterwards remain pending for the next job.
 */
export class MarketDataControlPlane extends Context.Service<
  MarketDataControlPlane,
  {
    readonly startIngestionRun: (
      input: StartIngestionRun,
    ) => Effect.Effect<void, MarketDataControlPlaneError>;
    readonly completeIngestionRun: (
      input: CompleteIngestionRun,
    ) => Effect.Effect<void, MarketDataControlPlaneError>;
    readonly failIngestionRun: (
      runId: string,
      message: string,
      completedAt: string,
    ) => Effect.Effect<void, MarketDataControlPlaneError>;
    readonly createProcessingJob: (
      input: CreateProcessingJob,
    ) => Effect.Effect<ProcessingJob, MarketDataControlPlaneError>;
    readonly readProcessingJob: (
      jobId: string,
    ) => Effect.Effect<ProcessingJob, MarketDataControlPlaneError>;
    readonly claimProcessingJob: (
      jobId: string,
      startedAt: string,
    ) => Effect.Effect<void, MarketDataControlPlaneError>;
    readonly completeProcessingJob: (
      input: CompleteProcessingJob,
    ) => Effect.Effect<void, MarketDataControlPlaneError>;
    readonly failProcessingJob: (
      jobId: string,
      message: string,
      completedAt: string,
    ) => Effect.Effect<void, MarketDataControlPlaneError>;
  }
>()("data-service/MarketDataControlPlane") {}
