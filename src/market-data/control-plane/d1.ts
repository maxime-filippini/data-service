import { Effect, Layer } from "effect";

import {
  ControlPlaneError,
  MarketDataControlPlane,
  type ProcessingManifest,
} from "$/market-data/control-plane";
import { canonicalKey, type Dataset, type Provider } from "$/market-data/schemas";

interface ClaimedJobRow {
  readonly job_id: string;
  readonly dataset: Dataset;
  readonly symbol: string;
  readonly run_id: string;
  readonly provider: Provider;
  readonly requested_from: string;
  readonly requested_to: string;
  readonly object_key: string;
  readonly object_etag: string;
  readonly row_count: number;
}

const query = <A>(
  operation: () => Promise<A>,
  message: string,
  context: { readonly runId?: string; readonly jobId?: string } = {},
) =>
  Effect.tryPromise({
    try: operation,
    catch: () => new ControlPlaneError({ message, ...context }),
  });

// The latest completed run per (dataset, symbol) that no job has used yet.
// A failed job is not retried for the same run; the next download gets a new job.
const pendingJobsInsert = (extraCondition = "") => `
  INSERT INTO processing_jobs (job_id, dataset, symbol, run_id, status, created_at)
  SELECT lower(hex(randomblob(16))), run.dataset, run.symbol, run.run_id, 'queued', ?
  FROM ingestion_runs AS run
  WHERE run.status = 'completed'
    AND NOT EXISTS (
      SELECT 1 FROM ingestion_runs AS newer
      WHERE newer.dataset = run.dataset AND newer.symbol = run.symbol
        AND newer.status = 'completed'
        AND (newer.created_at > run.created_at
          OR (newer.created_at = run.created_at AND newer.run_id > run.run_id))
    )
    AND NOT EXISTS (SELECT 1 FROM processing_jobs AS job WHERE job.run_id = run.run_id)
    AND NOT EXISTS (
      SELECT 1 FROM processing_jobs AS active
      WHERE active.dataset = run.dataset AND active.symbol = run.symbol
        AND active.status IN ('queued', 'processing')
    )
    ${extraCondition}
  ON CONFLICT DO NOTHING`;

const CREATE_PENDING_JOBS = pendingJobsInsert();
const CREATE_JOB_FOR_RUN = `${pendingJobsInsert("AND run.run_id = ?")} RETURNING job_id`;

const toManifest = (row: ClaimedJobRow): ProcessingManifest => ({
  jobId: row.job_id,
  dataset: row.dataset,
  symbol: row.symbol,
  outputKey: canonicalKey(row.dataset, row.symbol),
  input: {
    runId: row.run_id,
    provider: row.provider,
    requestedRange: { from: row.requested_from, to: row.requested_to },
    key: row.object_key,
    etag: row.object_etag,
    rowCount: row.row_count,
  },
});

export const D1MarketDataControlPlaneLive = (
  db: D1Database,
): Layer.Layer<MarketDataControlPlane> =>
  Layer.succeed(
    MarketDataControlPlane,
    MarketDataControlPlane.of({
      startIngestionRun: (input) =>
        query(
          () =>
            db.batch([
              db
                .prepare(
                  `UPDATE ingestion_runs
                   SET status = 'failed', completed_at = ?, error = 'Timed out while fetching'
                   WHERE dataset = ? AND symbol = ? AND status = 'fetching' AND created_at < ?`,
                )
                .bind(input.createdAt, input.dataset, input.symbol, input.staleBefore),
              db
                .prepare(
                  `INSERT INTO ingestion_runs (run_id, dataset, symbol, provider,
                     requested_from, requested_to, status, created_at)
                   SELECT ?, ?, ?, ?, ?, ?, 'fetching', ?
                   WHERE NOT EXISTS (
                     SELECT 1 FROM ingestion_runs
                     WHERE dataset = ? AND symbol = ? AND status = 'fetching'
                   )`,
                )
                .bind(
                  input.runId,
                  input.dataset,
                  input.symbol,
                  input.provider,
                  input.requestedRange.from,
                  input.requestedRange.to,
                  input.createdAt,
                  input.dataset,
                  input.symbol,
                ),
            ]),
          "Could not create the ingestion run",
          { runId: input.runId },
        ).pipe(Effect.map(([, insert]) => insert!.meta.changes === 1)),

      completeIngestionRun: ({ runId, object, completedAt }) =>
        query(
          () =>
            db
              .prepare(
                `UPDATE ingestion_runs SET status = 'completed', completed_at = ?,
                   object_key = ?, object_etag = ?, row_count = ?,
                   observed_from = ?, observed_to = ?
                 WHERE run_id = ? AND status = 'fetching'`,
              )
              .bind(
                completedAt,
                object.key,
                object.etag,
                object.rowCount,
                object.observedRange?.from ?? null,
                object.observedRange?.to ?? null,
                runId,
              )
              .run(),
          "Could not complete the ingestion run",
          { runId },
        ).pipe(Effect.asVoid),

      failIngestionRun: (runId, message, at) =>
        query(
          () =>
            db
              .prepare(
                `UPDATE ingestion_runs SET status = 'failed', completed_at = ?, error = ?
                 WHERE run_id = ? AND status = 'fetching'`,
              )
              .bind(at, message, runId)
              .run(),
          "Could not fail the ingestion run",
          { runId },
        ).pipe(Effect.asVoid),

      createPendingJobs: (createdAt) =>
        query(
          () => db.prepare(CREATE_PENDING_JOBS).bind(createdAt).run(),
          "Could not create processing jobs",
        ).pipe(Effect.map((result) => result.meta.changes)),

      createJobForRun: (runId, createdAt) =>
        query(
          () => db.prepare(CREATE_JOB_FOR_RUN).bind(createdAt, runId).first<{ job_id: string }>(),
          "Could not create the processing job",
          { runId },
        ).pipe(Effect.map((row) => row?.job_id)),

      failStaleJobs: (startedBefore, at) =>
        query(
          () =>
            db
              .prepare(
                `UPDATE processing_jobs
                 SET status = 'failed', completed_at = ?, error = 'Timed out while processing'
                 WHERE status = 'processing' AND started_at < ?`,
              )
              .bind(at, startedBefore)
              .run(),
          "Could not fail stale processing jobs",
        ).pipe(Effect.map((result) => result.meta.changes)),

      listQueuedJobIds: () =>
        query(
          () =>
            db
              .prepare(`SELECT job_id FROM processing_jobs WHERE status = 'queued' ORDER BY job_id`)
              .all<{ job_id: string }>(),
          "Could not list queued processing jobs",
        ).pipe(Effect.map((result) => result.results.map((row) => row.job_id))),

      claimJob: (jobId, startedAt) =>
        query(
          () =>
            db.batch<ClaimedJobRow>([
              db
                .prepare(
                  `UPDATE processing_jobs SET status = 'processing', started_at = ?
                   WHERE job_id = ? AND status = 'queued'`,
                )
                .bind(startedAt, jobId),
              db
                .prepare(
                  `SELECT job.job_id, job.dataset, job.symbol, job.run_id, run.provider,
                     run.requested_from, run.requested_to,
                     run.object_key, run.object_etag, run.row_count
                   FROM processing_jobs AS job
                   JOIN ingestion_runs AS run ON run.run_id = job.run_id
                   WHERE job.job_id = ?`,
                )
                .bind(jobId),
            ]),
          "Could not claim the processing job",
          { jobId },
        ).pipe(
          Effect.map(([update, select]) => {
            const row = select.results[0];
            return update.meta.changes === 1 && row !== undefined ? toManifest(row) : undefined;
          }),
        ),

      completeJob: (jobId, outputEtag, at) =>
        query(
          () =>
            db
              .prepare(
                `UPDATE processing_jobs SET status = 'completed', completed_at = ?, output_etag = ?
                 WHERE job_id = ? AND status = 'processing'`,
              )
              .bind(at, outputEtag, jobId)
              .run(),
          "Could not complete the processing job",
          { jobId },
        ).pipe(Effect.asVoid),

      failJob: (jobId, message, at) =>
        query(
          () =>
            db
              .prepare(
                `UPDATE processing_jobs SET status = 'failed', completed_at = ?, error = ?
                 WHERE job_id = ? AND status = 'processing'`,
              )
              .bind(at, message, jobId)
              .run(),
          "Could not fail the processing job",
          { jobId },
        ).pipe(Effect.asVoid),

      releaseJob: (jobId) =>
        query(
          () =>
            db
              .prepare(
                `UPDATE processing_jobs SET status = 'queued', started_at = NULL
                 WHERE job_id = ? AND status = 'processing'`,
              )
              .bind(jobId)
              .run(),
          "Could not release the processing job",
          { jobId },
        ).pipe(Effect.asVoid),
    }),
  );
