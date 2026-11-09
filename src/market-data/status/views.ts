// Read-only views of the pipeline, as returned by the dashboard API. This file
// has no imports so the dashboard app can import its types directly.

/**
 * Download state only. A completed ingestion stored raw data; inspect its
 * processing job separately to learn whether canonical Parquet was rebuilt.
 */
export type RunStatus = "fetching" | "completed" | "failed";

/**
 * Lifecycle of rebuilding one symbol's Parquet object from a completed ingestion.
 */
export type JobStatus = "queued" | "processing" | "completed" | "failed";

/**
 * Read-only processing history shown alongside downloads. `runId` identifies
 * the raw ingestion being rebuilt; timestamps and error describe this job,
 * not the provider download or the freshness of every canonical object.
 */
export interface ProcessingJobView {
  readonly jobId: string;
  readonly runId: string;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly error: string | null;
}

/**
 * Download history entry with requested/observed dates, raw-object metadata
 * and its latest processing job. Used by run lists to distinguish provider
 * progress from the later Parquet rebuild; absent results remain null.
 */
export interface IngestionRunView {
  readonly runId: string;
  readonly dataset: string;
  readonly symbol: string;
  readonly provider: string;
  readonly status: RunStatus;
  readonly requestedFrom: string;
  readonly requestedTo: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly error: string | null;
  readonly objectKey: string | null;
  readonly rowCount: number | null;
  readonly observedFrom: string | null;
  readonly observedTo: string | null;
  /** The run's latest processing job, if it has one. */
  readonly job: ProcessingJobView | null;
}

/**
 * Newest-first page of ingestion history. Pass `nextCursor` back with the
 * same filters to fetch older entries; null means no older page was found.
 */
export interface RunPage {
  readonly runs: readonly IngestionRunView[];
  /** Pass as `cursor` to get the next, older page. Null on the last page. */
  readonly nextCursor: string | null;
}

/**
 * Tracked symbol enriched for dashboard lists with its latest download,
 * latest successful download and latest rebuild. Those may refer to different
 * ingestion runs; a recent success alone does not prove Parquet is up to date.
 */
export interface SymbolStatusView {
  readonly dataset: string;
  readonly symbol: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly backfillStartDate: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestRun: {
    readonly runId: string;
    readonly status: RunStatus;
    readonly createdAt: string;
    readonly completedAt: string | null;
    readonly error: string | null;
  } | null;
  readonly lastCompletedRun: {
    readonly runId: string;
    readonly completedAt: string;
    readonly rowCount: number;
    readonly observedTo: string | null;
  } | null;
  readonly latestJob: ProcessingJobView | null;
}

/**
 * Allowlisted Access identity returned by `/app-api/me` for presentation.
 * It is produced after authentication, not accepted as a client-supplied identity.
 */
export interface DashboardUser {
  readonly email: string;
}
