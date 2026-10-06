import { Effect, Layer, Result } from "effect";

import { MarketDataControlPlane } from "$/market-data/control-plane";
import { prepareSymbolProcessingJob, readSymbolProcessingJob } from "$/market-data/processing";

export interface ProcessingMessage {
  readonly jobId: string;
}

const pageSize = 100;

/** D1 is the durable source of queued work, including failed queue publications. */
export async function scheduleProcessing(
  database: D1Database,
  queue: Pick<Queue<ProcessingMessage>, "sendBatch">,
  controlPlane: Layer.Layer<MarketDataControlPlane>,
  createdAt: string,
) {
  let afterSymbol = "";
  while (true) {
    const page = await database.prepare(`
      SELECT DISTINCT run.symbol FROM ingestion_runs AS run
      WHERE run.status = 'raw_complete' AND run.symbol > ?
        AND NOT EXISTS (
          SELECT 1 FROM canonical_run_applications AS application
          WHERE application.symbol = run.symbol AND application.run_id = run.run_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM processing_jobs AS job
          WHERE job.symbol = run.symbol AND job.status IN ('queued', 'processing')
        )
        AND NOT EXISTS (
          SELECT 1 FROM processing_jobs AS failed
          JOIN processing_job_runs AS selected ON selected.job_id = failed.job_id
          WHERE failed.symbol = run.symbol AND failed.status = 'failed'
            AND NOT EXISTS (
              SELECT 1 FROM canonical_run_applications AS applied
              WHERE applied.symbol = failed.symbol AND applied.run_id = selected.run_id
            )
        )
      ORDER BY run.symbol LIMIT ?
    `).bind(afterSymbol, pageSize).all<{ symbol: string }>();
    for (const { symbol } of page.results) {
      const result = await prepareSymbolProcessingJob({
        jobId: crypto.randomUUID(), symbol, mode: "merge",
        transformVersion: "v1", createdAt,
      }).pipe(Effect.provide(controlPlane), Effect.result, Effect.runPromise);
      if (Result.isFailure(result) && result.failure.kind !== "conflict" && result.failure.kind !== "no_work") {
        throw result.failure;
      }
    }
    if (page.results.length < pageSize) break;
    afterSymbol = page.results.at(-1)!.symbol;
  }

  let afterJob = "";
  while (true) {
    const page = await database.prepare(`
      SELECT job_id FROM processing_jobs
      WHERE status = 'queued' AND job_id > ? ORDER BY job_id LIMIT ?
    `).bind(afterJob, pageSize).all<{ job_id: string }>();
    if (page.results.length > 0) {
      await queue.sendBatch(page.results.map(({ job_id }) => ({ body: { jobId: job_id } })));
    }
    if (page.results.length < pageSize) break;
    afterJob = page.results.at(-1)!.job_id;
  }
}

/** Delivery is at least once; the processor's atomic claim remains authoritative. */
export async function executeProcessingMessage(
  body: unknown,
  controlPlane: Layer.Layer<MarketDataControlPlane>,
  processor: Pick<Fetcher, "fetch">,
  token: string,
) {
  if (typeof body !== "object" || body === null || !("jobId" in body) ||
      typeof body.jobId !== "string" || body.jobId.length === 0) {
    throw new Error("Invalid processing queue message");
  }
  const jobId = body.jobId;
  const read = () => readSymbolProcessingJob(jobId).pipe(
    Effect.provide(controlPlane), Effect.runPromise,
  );
  const job = await read();
  if (job.status === "completed" || job.status === "failed") return;
  if (job.status === "processing") {
    throw new Error("Processing job is already claimed; reconcile if execution was interrupted");
  }

  const response = await processor.fetch(new Request(
    `http://processor/processing-jobs/${encodeURIComponent(job.jobId)}/execute`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  ));
  await response.body?.cancel();
  // A response (even a 2xx) alone does not establish durable completion.
  const finalJob = await read();
  if (finalJob.status === "completed") return;
  if (finalJob.status === "failed") {
    console.error(JSON.stringify({ event: "processing_job_failed", jobId: job.jobId, status: response.status }));
    return;
  }
  throw new Error(`Processor did not complete job (${response.status}, ${finalJob.status})`);
}
