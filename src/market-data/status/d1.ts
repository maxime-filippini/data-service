import { Effect, Layer } from "effect";

import {
  decodeCursor,
  encodeCursor,
  type IngestionRunView,
  type JobStatus,
  PipelineStatus,
  PipelineStatusError,
  type ProcessingJobView,
  type RunStatus,
  type SymbolStatusView,
} from "$/market-data/status";

interface JobColumns {
  readonly job_id: string | null;
  readonly job_run_id: string | null;
  readonly job_status: JobStatus | null;
  readonly job_created_at: string | null;
  readonly job_started_at: string | null;
  readonly job_completed_at: string | null;
  readonly job_error: string | null;
}

interface RunRow extends JobColumns {
  readonly run_id: string;
  readonly dataset: string;
  readonly symbol: string;
  readonly provider: string;
  readonly status: RunStatus;
  readonly requested_from: string;
  readonly requested_to: string;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly error: string | null;
  readonly object_key: string | null;
  readonly row_count: number | null;
  readonly observed_from: string | null;
  readonly observed_to: string | null;
}

interface SymbolRow extends JobColumns {
  readonly dataset: string;
  readonly symbol: string;
  readonly provider: string;
  readonly enabled: number;
  readonly backfill_start_date: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly latest_run_id: string | null;
  readonly latest_status: RunStatus | null;
  readonly latest_created_at: string | null;
  readonly latest_completed_at: string | null;
  readonly latest_error: string | null;
  readonly done_run_id: string | null;
  readonly done_completed_at: string | null;
  readonly done_row_count: number | null;
  readonly done_observed_to: string | null;
}

const JOB_COLUMNS = `
  job.job_id, job.run_id AS job_run_id, job.status AS job_status,
  job.created_at AS job_created_at, job.started_at AS job_started_at,
  job.completed_at AS job_completed_at, job.error AS job_error`;

const LIST_RUNS = `
  SELECT run.run_id, run.dataset, run.symbol, run.provider, run.status,
    run.requested_from, run.requested_to, run.created_at, run.completed_at, run.error,
    run.object_key, run.row_count, run.observed_from, run.observed_to,
    ${JOB_COLUMNS}
  FROM ingestion_runs AS run
  LEFT JOIN processing_jobs AS job ON job.job_id = (
    SELECT latest.job_id FROM processing_jobs AS latest
    WHERE latest.run_id = run.run_id
    ORDER BY latest.created_at DESC, latest.job_id DESC LIMIT 1
  )
  WHERE (?1 IS NULL OR run.dataset = ?1)
    AND (?2 IS NULL OR run.symbol = ?2)
    AND (?3 IS NULL OR run.status = ?3)
    AND (?4 IS NULL OR run.created_at < ?4 OR (run.created_at = ?4 AND run.run_id < ?5))
  ORDER BY run.created_at DESC, run.run_id DESC
  LIMIT ?6`;

// Latest run, latest completed run and latest job for each tracked symbol.
const LIST_SYMBOLS = `
  SELECT s.dataset, s.symbol, s.provider, s.enabled, s.backfill_start_date,
    s.created_at, s.updated_at,
    latest.run_id AS latest_run_id, latest.status AS latest_status,
    latest.created_at AS latest_created_at, latest.completed_at AS latest_completed_at,
    latest.error AS latest_error,
    done.run_id AS done_run_id, done.completed_at AS done_completed_at,
    done.row_count AS done_row_count, done.observed_to AS done_observed_to,
    ${JOB_COLUMNS}
  FROM tracked_symbols AS s
  LEFT JOIN ingestion_runs AS latest ON latest.run_id = (
    SELECT run.run_id FROM ingestion_runs AS run
    WHERE run.dataset = s.dataset AND run.symbol = s.symbol
    ORDER BY run.created_at DESC, run.run_id DESC LIMIT 1
  )
  LEFT JOIN ingestion_runs AS done ON done.run_id = (
    SELECT run.run_id FROM ingestion_runs AS run
    WHERE run.dataset = s.dataset AND run.symbol = s.symbol AND run.status = 'completed'
    ORDER BY run.created_at DESC, run.run_id DESC LIMIT 1
  )
  LEFT JOIN processing_jobs AS job ON job.job_id = (
    SELECT j.job_id FROM processing_jobs AS j
    WHERE j.dataset = s.dataset AND j.symbol = s.symbol
    ORDER BY j.created_at DESC, j.job_id DESC LIMIT 1
  )
  WHERE (?1 IS NULL OR s.dataset = ?1) AND (?2 IS NULL OR s.enabled = ?2)
  ORDER BY s.dataset, s.symbol`;

const jobFromRow = (row: JobColumns): ProcessingJobView | null =>
  row.job_id === null
    ? null
    : {
        jobId: row.job_id,
        runId: row.job_run_id!,
        status: row.job_status!,
        createdAt: row.job_created_at!,
        startedAt: row.job_started_at,
        completedAt: row.job_completed_at,
        error: row.job_error,
      };

const runFromRow = (row: RunRow): IngestionRunView => ({
  runId: row.run_id,
  dataset: row.dataset,
  symbol: row.symbol,
  provider: row.provider,
  status: row.status,
  requestedFrom: row.requested_from,
  requestedTo: row.requested_to,
  createdAt: row.created_at,
  completedAt: row.completed_at,
  error: row.error,
  objectKey: row.object_key,
  rowCount: row.row_count,
  observedFrom: row.observed_from,
  observedTo: row.observed_to,
  job: jobFromRow(row),
});

const symbolFromRow = (row: SymbolRow): SymbolStatusView => ({
  dataset: row.dataset,
  symbol: row.symbol,
  provider: row.provider,
  enabled: row.enabled === 1,
  backfillStartDate: row.backfill_start_date,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  latestRun:
    row.latest_run_id === null
      ? null
      : {
          runId: row.latest_run_id,
          status: row.latest_status!,
          createdAt: row.latest_created_at!,
          completedAt: row.latest_completed_at,
          error: row.latest_error,
        },
  lastCompletedRun:
    row.done_run_id === null
      ? null
      : {
          runId: row.done_run_id,
          completedAt: row.done_completed_at!,
          rowCount: row.done_row_count!,
          observedTo: row.done_observed_to,
        },
  latestJob: jobFromRow(row),
});

const query = <A>(operation: () => Promise<A>, message: string) =>
  Effect.tryPromise({ try: operation, catch: () => new PipelineStatusError({ message }) });

export const D1PipelineStatusLive = (db: D1Database): Layer.Layer<PipelineStatus> =>
  Layer.succeed(
    PipelineStatus,
    PipelineStatus.of({
      listRuns: ({ dataset, symbol, status, cursor, limit }) => {
        const after = cursor === undefined ? undefined : decodeCursor(cursor);
        return query(
          () =>
            db
              .prepare(LIST_RUNS)
              .bind(
                dataset ?? null,
                symbol ?? null,
                status ?? null,
                after?.createdAt ?? null,
                after?.runId ?? null,
                // One extra row tells us whether there is another page.
                limit + 1,
              )
              .all<RunRow>(),
          "Could not list ingestion runs",
        ).pipe(
          Effect.map(({ results }) => {
            const runs = results.slice(0, limit).map(runFromRow);
            const last = runs.at(-1);
            return {
              runs,
              nextCursor: results.length > limit && last ? encodeCursor(last.createdAt, last.runId) : null,
            };
          }),
        );
      },

      listSymbols: ({ dataset, enabled }) =>
        query(
          () =>
            db
              .prepare(LIST_SYMBOLS)
              .bind(dataset ?? null, enabled === undefined ? null : Number(enabled))
              .all<SymbolRow>(),
          "Could not list symbols",
        ).pipe(Effect.map(({ results }) => results.map(symbolFromRow))),
    }),
  );
