// Read-only views of the pipeline, as returned by the dashboard API. This file
// has no imports so the dashboard app can import its types directly.

export type RunStatus = "fetching" | "completed" | "failed";
export type JobStatus = "queued" | "processing" | "completed" | "failed";

export interface ProcessingJobView {
  readonly jobId: string;
  readonly runId: string;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly error: string | null;
}

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

export interface RunPage {
  readonly runs: readonly IngestionRunView[];
  /** Pass as `cursor` to get the next, older page. Null on the last page. */
  readonly nextCursor: string | null;
}

/** A tracked symbol with its latest pipeline activity. */
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

export interface DashboardUser {
  readonly email: string;
}
