import { Effect, Layer } from "effect";

import {
  type CompleteIngestionRun,
  type CompleteProcessingJob,
  type CreateProcessingJob,
  MarketDataControlPlane,
  MarketDataControlPlaneError,
  type ProcessingJob,
  type ProcessingJobMode,
  type ProcessingJobRun,
  type ProcessingJobStatus,
  type StartIngestionRun,
} from "$/market-data/control-plane";

interface CanonicalRow {
  readonly object_etag: string | null;
}

interface ActiveJobRow {
  readonly job_id: string;
}

interface SelectedRunRow {
  readonly run_id: string;
}

interface ProcessingJobRow {
  readonly job_id: string;
  readonly symbol: string;
  readonly mode: ProcessingJobMode;
  readonly canonical_key: string;
  readonly expected_base_etag: string | null;
  readonly transform_version: string;
  readonly status: ProcessingJobStatus;
  readonly created_at: string;
}

interface ProcessingJobRunRow {
  readonly run_id: string;
  readonly provider: string;
  readonly requested_from: string;
  readonly requested_to: string;
  readonly precedence: number;
  readonly completed_at: string | null;
}

interface ProcessingJobObjectRow {
  readonly run_id: string;
  readonly object_key: string;
  readonly object_etag: string;
  readonly observed_from: string | null;
  readonly observed_to: string | null;
  readonly row_count: number;
}

const controlPlaneError = (
  kind: "database" | "conflict" | "not_found" | "no_work",
  message: string,
  context: {
    readonly runId?: string;
    readonly jobId?: string;
    readonly symbol?: string;
  } = {},
) =>
  new MarketDataControlPlaneError({
    kind,
    message,
    ...context,
  });

const databaseOperation = <T>(
  operation: () => Promise<T>,
  message: string,
  context?: {
    readonly runId?: string;
    readonly jobId?: string;
    readonly symbol?: string;
  },
) =>
  Effect.tryPromise({
    try: operation,
    catch: () => controlPlaneError("database", message, context),
  });

const startIngestionRun = (database: D1Database, input: StartIngestionRun) =>
  databaseOperation(
    () =>
      database
        .prepare(
          `INSERT INTO ingestion_runs (
            run_id,
            provider,
            symbol,
            requested_from,
            requested_to,
            status,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'fetching', ?)`,
        )
        .bind(
          input.runId,
          input.provider,
          input.symbol,
          input.requestedRange.from,
          input.requestedRange.to,
          input.createdAt,
        )
        .run(),
    "Could not create the ingestion run",
    { runId: input.runId, symbol: input.symbol },
  ).pipe(Effect.asVoid);

const completeIngestionRun = (
  database: D1Database,
  input: CompleteIngestionRun,
) =>
  databaseOperation(
    () =>
      database.batch([
        database
          .prepare(
            `INSERT INTO ingestion_run_objects (
              run_id,
              object_key,
              object_etag,
              observed_from,
              observed_to,
              row_count
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.runId,
            input.object.key,
            input.object.etag,
            input.object.observedRange?.from ?? null,
            input.object.observedRange?.to ?? null,
            input.object.rowCount,
          ),
        database
          .prepare(
            `UPDATE ingestion_runs
             SET status = 'raw_complete', completed_at = ?, error = NULL
             WHERE run_id = ? AND status = 'fetching'`,
          )
          .bind(input.completedAt, input.runId),
      ]),
    "Could not complete the ingestion run",
    { runId: input.runId },
  ).pipe(Effect.asVoid);

const failIngestionRun = (
  database: D1Database,
  runId: string,
  message: string,
  completedAt: string,
) =>
  databaseOperation(
    () =>
      database
        .prepare(
          `UPDATE ingestion_runs
           SET status = 'failed', completed_at = ?, error = ?
           WHERE run_id = ? AND status = 'fetching'`,
        )
        .bind(completedAt, message, runId)
        .run(),
    "Could not fail the ingestion run",
    { runId },
  ).pipe(Effect.asVoid);

const selectedRunsQuery = (mode: ProcessingJobMode) =>
  mode === "rebuild"
    ? `SELECT run_id
       FROM ingestion_runs
       WHERE symbol = ? AND status = 'raw_complete'
       ORDER BY completed_at, run_id`
    : `SELECT run_id
       FROM ingestion_runs AS run
       WHERE run.symbol = ?
         AND run.status = 'raw_complete'
         AND NOT EXISTS (
           SELECT 1
           FROM canonical_run_applications AS application
           WHERE application.symbol = run.symbol
             AND application.run_id = run.run_id
         )
       ORDER BY run.completed_at, run.run_id`;

const readProcessingJob = Effect.fn("D1ControlPlane.readProcessingJob")(
  function* (database: D1Database, jobId: string) {
    const job = yield* databaseOperation(
      () =>
        database
          .prepare(
            `SELECT
              job_id,
              symbol,
              mode,
              canonical_key,
              expected_base_etag,
              transform_version,
              status,
              created_at
            FROM processing_jobs
            WHERE job_id = ?`,
          )
          .bind(jobId)
          .first<ProcessingJobRow>(),
      "Could not read the processing job",
      { jobId },
    );

    if (job === null) {
      return yield* Effect.fail(
        controlPlaneError("not_found", "The processing job does not exist", {
          jobId,
        }),
      );
    }

    const [runResult, objectResult] = yield* databaseOperation(
      () =>
        database.batch([
          database
            .prepare(
              `SELECT
                selected.run_id,
                run.provider,
                run.requested_from,
                run.requested_to,
                selected.precedence,
                run.completed_at
              FROM processing_job_runs AS selected
              JOIN ingestion_runs AS run ON run.run_id = selected.run_id
              WHERE selected.job_id = ?
              ORDER BY selected.precedence`,
            )
            .bind(jobId),
          database
            .prepare(
              `SELECT
                selected.run_id,
                object.object_key,
                object.object_etag,
                object.observed_from,
                object.observed_to,
                object.row_count
              FROM processing_job_runs AS selected
              JOIN ingestion_run_objects AS object
                ON object.run_id = selected.run_id
              WHERE selected.job_id = ?
              ORDER BY selected.precedence, object.object_key`,
            )
            .bind(jobId),
        ]),
      "Could not read the processing-job inputs",
      { jobId, symbol: job.symbol },
    );

    const objectsByRun = new Map<
      string,
      ProcessingJobRun["objects"][number][]
    >();

    for (const object of objectResult.results as ProcessingJobObjectRow[]) {
      const objects = objectsByRun.get(object.run_id) ?? [];
      objects.push({
        key: object.object_key,
        etag: object.object_etag,
        ...(object.observed_from !== null && object.observed_to !== null
          ? {
              observedRange: {
                from: object.observed_from,
                to: object.observed_to,
              },
            }
          : {}),
        rowCount: object.row_count,
      });
      objectsByRun.set(object.run_id, objects);
    }

    const runs: ProcessingJobRun[] = [];
    for (const run of runResult.results as ProcessingJobRunRow[]) {
      if (run.completed_at === null) {
        return yield* Effect.fail(
          controlPlaneError(
            "database",
            "A selected ingestion run was not complete",
            { jobId, runId: run.run_id, symbol: job.symbol },
          ),
        );
      }

      runs.push({
        runId: run.run_id,
        provider: run.provider,
        requestedRange: {
          from: run.requested_from,
          to: run.requested_to,
        },
        precedence: run.precedence,
        completedAt: run.completed_at,
        objects: objectsByRun.get(run.run_id) ?? [],
      });
    }

    return {
      jobId: job.job_id,
      symbol: job.symbol,
      mode: job.mode,
      canonicalKey: job.canonical_key,
      ...(job.expected_base_etag === null
        ? {}
        : { expectedBaseEtag: job.expected_base_etag }),
      transformVersion: job.transform_version,
      status: job.status,
      createdAt: job.created_at,
      runs,
    } satisfies ProcessingJob;
  },
);

const createProcessingJob = Effect.fn("D1ControlPlane.createProcessingJob")(
  function* (database: D1Database, input: CreateProcessingJob) {
    const activeJob = yield* databaseOperation(
      () =>
        database
          .prepare(
            `SELECT job_id
             FROM processing_jobs
             WHERE symbol = ? AND status IN ('queued', 'processing')
             LIMIT 1`,
          )
          .bind(input.symbol)
          .first<ActiveJobRow>(),
      "Could not check for an active processing job",
      { jobId: input.jobId, symbol: input.symbol },
    );

    if (activeJob !== null) {
      return yield* Effect.fail(
        controlPlaneError(
          "conflict",
          "The symbol already has an active processing job",
          { jobId: activeJob.job_id, symbol: input.symbol },
        ),
      );
    }

    const [canonical, selected] = yield* Effect.all([
      databaseOperation(
        () =>
          database
            .prepare(
              `SELECT object_etag FROM canonical_datasets WHERE symbol = ?`,
            )
            .bind(input.symbol)
            .first<CanonicalRow>(),
        "Could not read the canonical dataset",
        { jobId: input.jobId, symbol: input.symbol },
      ),
      databaseOperation(
        () =>
          database
            .prepare(selectedRunsQuery(input.mode))
            .bind(input.symbol)
            .all<SelectedRunRow>(),
        "Could not select ingestion runs for processing",
        { jobId: input.jobId, symbol: input.symbol },
      ),
    ]);

    if (selected.results.length === 0) {
      return yield* Effect.fail(
        controlPlaneError(
          "no_work",
          "No completed ingestion runs are available for processing",
          { jobId: input.jobId, symbol: input.symbol },
        ),
      );
    }

    const statements = [
      database
        .prepare(
          `INSERT INTO canonical_datasets (symbol, object_key)
           VALUES (?, ?)
           ON CONFLICT (symbol) DO NOTHING`,
        )
        .bind(input.symbol, input.canonicalKey),
      database
        .prepare(
          `INSERT INTO processing_jobs (
            job_id,
            symbol,
            mode,
            canonical_key,
            expected_base_etag,
            transform_version,
            status,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .bind(
          input.jobId,
          input.symbol,
          input.mode,
          input.canonicalKey,
          input.mode === "merge" ? (canonical?.object_etag ?? null) : null,
          input.transformVersion,
          input.createdAt,
        ),
      ...selected.results.map((run, precedence) =>
        database
          .prepare(
            `INSERT INTO processing_job_runs (job_id, run_id, precedence)
             VALUES (?, ?, ?)`,
          )
          .bind(input.jobId, run.run_id, precedence),
      ),
      database
        .prepare(
          `UPDATE canonical_datasets
           SET active_job_id = ?
           WHERE symbol = ? AND active_job_id IS NULL`,
        )
        .bind(input.jobId, input.symbol),
    ];

    yield* databaseOperation(
      () => database.batch(statements),
      "Could not create the processing job",
      { jobId: input.jobId, symbol: input.symbol },
    );

    return yield* readProcessingJob(database, input.jobId);
  },
);

const claimProcessingJob = (
  database: D1Database,
  jobId: string,
  startedAt: string,
) =>
  Effect.gen(function* () {
    const result = yield* databaseOperation(
      () =>
        database
          .prepare(
            `UPDATE processing_jobs
             SET status = 'processing', started_at = ?, error = NULL
             WHERE job_id = ? AND status = 'queued'`,
          )
          .bind(startedAt, jobId)
          .run(),
      "Could not claim the processing job",
      { jobId },
    );

    if (result.meta.changes !== 1) {
      return yield* Effect.fail(
        controlPlaneError(
          "conflict",
          "The processing job is not available to claim",
          { jobId },
        ),
      );
    }
  });

const completeProcessingJob = Effect.fn("D1ControlPlane.completeProcessingJob")(
  function* (database: D1Database, input: CompleteProcessingJob) {
    const job = yield* databaseOperation(
      () =>
        database
          .prepare(
            `SELECT job_id, symbol, status
           FROM processing_jobs
           WHERE job_id = ?`,
          )
          .bind(input.jobId)
          .first<Pick<ProcessingJobRow, "job_id" | "symbol" | "status">>(),
      "Could not read the processing job before completion",
      { jobId: input.jobId },
    );

    if (job === null) {
      return yield* Effect.fail(
        controlPlaneError("not_found", "The processing job does not exist", {
          jobId: input.jobId,
        }),
      );
    }

    if (job.status !== "processing") {
      return yield* Effect.fail(
        controlPlaneError(
          "conflict",
          "The processing job must be claimed before completion",
          { jobId: input.jobId, symbol: job.symbol },
        ),
      );
    }

    yield* databaseOperation(
      () =>
        database.batch([
          database
            .prepare(
              `UPDATE canonical_datasets
             SET
               object_etag = ?,
               revision = revision + 1,
               complete_through = COALESCE(?, complete_through),
               active_job_id = NULL,
               updated_at = ?
             WHERE symbol = ? AND active_job_id = ?`,
            )
            .bind(
              input.outputEtag,
              input.completeThrough ?? null,
              input.completedAt,
              job.symbol,
              input.jobId,
            ),
          database
            .prepare(
              `INSERT INTO canonical_run_applications (
              symbol,
              run_id,
              job_id,
              canonical_revision,
              applied_at
            )
            SELECT
              ?,
              selected.run_id,
              ?,
              canonical.revision,
              ?
            FROM processing_job_runs AS selected
            JOIN canonical_datasets AS canonical ON canonical.symbol = ?
            WHERE selected.job_id = ?
            ON CONFLICT (symbol, run_id) DO UPDATE SET
              job_id = excluded.job_id,
              canonical_revision = excluded.canonical_revision,
              applied_at = excluded.applied_at`,
            )
            .bind(
              job.symbol,
              input.jobId,
              input.completedAt,
              job.symbol,
              input.jobId,
            ),
          database
            .prepare(
              `UPDATE processing_jobs
             SET
               status = 'completed',
               completed_at = ?,
               output_etag = ?,
               error = NULL
             WHERE job_id = ? AND status = 'processing'`,
            )
            .bind(input.completedAt, input.outputEtag, input.jobId),
        ]),
      "Could not complete the processing job",
      { jobId: input.jobId, symbol: job.symbol },
    );
  },
);

const failProcessingJob = (
  database: D1Database,
  jobId: string,
  message: string,
  completedAt: string,
) =>
  databaseOperation(
    () =>
      database.batch([
        database
          .prepare(
            `UPDATE canonical_datasets
             SET active_job_id = NULL
             WHERE active_job_id = ?`,
          )
          .bind(jobId),
        database
          .prepare(
            `UPDATE processing_jobs
             SET status = 'failed', completed_at = ?, error = ?
             WHERE job_id = ? AND status IN ('queued', 'processing')`,
          )
          .bind(completedAt, message, jobId),
      ]),
    "Could not fail the processing job",
    { jobId },
  ).pipe(Effect.asVoid);

/** D1 implementation of the market-data ingestion and processing control plane. */
export const D1MarketDataControlPlaneLive = (
  database: D1Database,
): Layer.Layer<MarketDataControlPlane> =>
  Layer.succeed(
    MarketDataControlPlane,
    MarketDataControlPlane.of({
      startIngestionRun: (input) => startIngestionRun(database, input),
      completeIngestionRun: (input) => completeIngestionRun(database, input),
      failIngestionRun: (runId, message, completedAt) =>
        failIngestionRun(database, runId, message, completedAt),
      createProcessingJob: (input) => createProcessingJob(database, input),
      readProcessingJob: (jobId) => readProcessingJob(database, jobId),
      claimProcessingJob: (jobId, startedAt) =>
        claimProcessingJob(database, jobId, startedAt),
      completeProcessingJob: (input) => completeProcessingJob(database, input),
      failProcessingJob: (jobId, message, completedAt) =>
        failProcessingJob(database, jobId, message, completedAt),
    }),
  );
