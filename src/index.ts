import { Effect, Layer } from "effect";

import { WorkerLoggerLive } from "$/logging";
import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import {
  type IngestionMessage,
  isRetryable,
  runIngestion,
} from "$/market-data/ingestion-queue";
import { processJob } from "$/market-data/processing";
import { R2RawMarketDataStoreLive } from "$/market-data/r2-raw-store";
import { liveSourceFor } from "$/market-data/sources";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { createRoutes } from "$/routes";
import { dependencies } from "$/dependencies";
import { runScheduledHandlers } from "$/scheduled";
// SvelteKit's handler, built by `pnpm --filter app build` (wrangler's build
// command runs it before dev and deploy). It has no type declarations.
// @ts-expect-error -- generated JavaScript, missing until the app is built
import sveltekit from "../app/.svelte-kit/cloudflare/_worker.js";

export { CalculationRunWorkflow } from "./calculation-run-workflow";
export { DefinitionRunWorkflow } from "./definition-run-workflow";
export { CalculationEngine } from "./engine-container";
export { MarketDataProcessor } from "./processor-container";
export { ScheduledDownloadWorkflow } from "./scheduled-download-workflow";
export { WorkflowDispatchWorkflow } from "./workflow-dispatch-workflow";
export { runScheduledHandlers } from "$/scheduled";

const app = createRoutes(dependencies, sveltekit);

const ingest = Effect.fn("Worker.ingest")(function* (
  batch: MessageBatch<IngestionMessage>,
  env: CloudflareBindings,
) {
  const layer = Layer.mergeAll(
    D1SymbolRegistryLive(env.MARKET_DATA_DB),
    D1MarketDataControlPlaneLive(env.MARKET_DATA_DB),
    R2RawMarketDataStoreLive(env.MARKET_DATA_BUCKET),
  );
  const dependencies = {
    sourceFor: liveSourceFor(env),
    processingQueue: env.PROCESSING_QUEUE,
  };

  for (const message of batch.messages) {
    const { dataset, symbol } = message.body;
    const result = yield* runIngestion(message.body, dependencies).pipe(
      Effect.provide(layer),
      Effect.result,
    );
    if (result._tag === "Success") {
      yield* Effect.logInfo("ingestion").pipe(
        Effect.annotateLogs({
          dataset,
          symbol,
          ...result.success,
        }),
      );
      message.ack();
    } else {
      const retry = isRetryable(result.failure);
      yield* Effect.logError("ingestion_failed").pipe(
        Effect.annotateLogs({
          dataset,
          symbol,
          error: result.failure._tag,
          message: result.failure.message,
          retry,
        }),
      );
      if (retry) message.retry();
      else message.ack();
    }
  }
});

export default {
  fetch: app.fetch,

  async scheduled(controller, env) {
    await runScheduledHandlers(
      new Date(controller.scheduledTime),
      env,
      dependencies,
    );
  },

  async queue(batch, env) {
    return Effect.gen(function* () {
      if (batch.queue === env.INGESTION_QUEUE_NAME) {
        yield* ingest(batch as MessageBatch<IngestionMessage>, env);
        return;
      }

      const controlPlane = D1MarketDataControlPlaneLive(env.MARKET_DATA_DB);
      const processor = env.MARKET_DATA_PROCESSOR.getByName("processor");

      for (const message of batch.messages) {
        const body = message.body as { jobId?: unknown };
        if (typeof body?.jobId !== "string") {
          yield* Effect.logError("invalid_processing_message").pipe(
            Effect.annotateLogs({
              messageId: message.id,
            }),
          );
          message.ack();
          continue;
        }

        const result = yield* processJob(body.jobId, processor).pipe(
          Effect.provide(controlPlane),
          Effect.result,
        );
        if (result._tag === "Success") {
          yield* Effect.logInfo("processing_job").pipe(
            Effect.annotateLogs({
              jobId: body.jobId,
              outcome: result.success,
            }),
          );
          message.ack();
        } else {
          yield* Effect.logError("processing_retry").pipe(
            Effect.annotateLogs({
              jobId: body.jobId,
              error: result.failure._tag,
            }),
          );
          message.retry();
        }
      }
    }).pipe(Effect.provide(WorkerLoggerLive), Effect.runPromise);
  },
} satisfies ExportedHandler<CloudflareBindings>;
