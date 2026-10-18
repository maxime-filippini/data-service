import { Effect, Schema } from "effect";

import { MarketDataControlPlane } from "$/market-data/control-plane";

export interface ProcessingMessage {
  readonly jobId: string;
}

/** A job still `processing` after this long is assumed dead and failed. */
export const STALE_JOB_MS = 60 * 60 * 1000;

const QUEUE_BATCH_SIZE = 100;

export class ProcessorUnavailable extends Schema.TaggedError<ProcessorUnavailable>()(
  "ProcessorUnavailable",
  { jobId: Schema.String },
) {}

/**
 * Daily housekeeping: fail stuck jobs, queue jobs for new runs, and (re)send
 * every queued job. D1 is the source of truth, so lost messages are resent.
 */
export const scheduleProcessing = Effect.fn("MarketData.scheduleProcessing")(function* (
  queue: Pick<Queue<ProcessingMessage>, "sendBatch">,
  now: Date,
) {
  const controlPlane = yield* MarketDataControlPlane;
  const at = now.toISOString();

  yield* controlPlane.failStaleJobs(new Date(now.getTime() - STALE_JOB_MS).toISOString(), at);
  yield* controlPlane.createPendingJobs(at);

  const jobIds = yield* controlPlane.listQueuedJobIds();
  for (let index = 0; index < jobIds.length; index += QUEUE_BATCH_SIZE) {
    const batch = jobIds.slice(index, index + QUEUE_BATCH_SIZE);
    yield* Effect.promise(() => queue.sendBatch(batch.map((jobId) => ({ body: { jobId } }))));
  }
});

const errorDetail = async (response: Response) => {
  const text = await response.text().catch(() => "");
  try {
    const detail = (JSON.parse(text) as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  } catch {
    // Not JSON; fall back to the raw text.
  }
  return text;
};

/**
 * Claim a job, hand its manifest to the processor container and record the
 * outcome. Fails with ProcessorUnavailable (job requeued) if the container
 * could not be reached, so the queue message should be retried.
 */
export const processJob = Effect.fn("MarketData.processJob")(function* (
  jobId: string,
  processor: Pick<Fetcher, "fetch">,
) {
  const controlPlane = yield* MarketDataControlPlane;
  const manifest = yield* controlPlane.claimJob(jobId, new Date().toISOString());
  if (manifest === undefined) {
    // Already processed, failed, or being processed by another delivery.
    return "skipped" as const;
  }

  const response = yield* Effect.tryPromise({
    try: () =>
      processor.fetch("http://processor/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest),
      }),
    catch: () => new ProcessorUnavailable({ jobId }),
  }).pipe(Effect.tapError(() => controlPlane.releaseJob(jobId)));

  const at = new Date().toISOString();
  if (response.ok) {
    const body = yield* Effect.promise(() => response.json().catch(() => ({})));
    const outputEtag = (body as { outputEtag?: unknown }).outputEtag;
    if (typeof outputEtag === "string" && outputEtag.length > 0) {
      yield* controlPlane.completeJob(jobId, outputEtag, at);
      return "completed" as const;
    }
    yield* controlPlane.failJob(jobId, "Processor response had no outputEtag", at);
    return "failed" as const;
  }

  const detail = yield* Effect.promise(() => errorDetail(response));
  yield* controlPlane.failJob(
    jobId,
    `Processor returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
    at,
  );
  return "failed" as const;
});
