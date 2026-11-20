import { Effect, Layer } from "effect";

import { D1CalculationsLive } from "$/calculations/d1";
import { failStoppedRuns } from "$/calculations/runs";
import { triggerScheduledCalculations } from "$/calculations/schedule";
import { WorkerLoggerLive } from "$/logging";
import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import {
  type IngestionMessage,
  isRetryable,
  runIngestion,
} from "$/market-data/ingestion-queue";
import { processJob, scheduleProcessing } from "$/market-data/processing";
import { R2RawMarketDataStoreLive } from "$/market-data/r2-raw-store";
import { triggerScheduledRun } from "$/market-data/schedule/operations";
import { D1ScheduleStoreLive } from "$/market-data/schedule/d1";
import { liveSourceFor } from "$/market-data/sources";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { createRoutes } from "$/routes";
import { dependencies } from "$/dependencies";
import { startScheduledWorkflowTick } from "$/workflows/runs/dispatch";
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

const app = createRoutes(dependencies, sveltekit);

/** The hour (UTC) at which the cron resends queued Parquet rebuilds. */
const PROCESSING_SWEEP_HOUR = 2;

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
    return Effect.gen(function* () {
      const now = new Date(controller.scheduledTime);

      const trigger = yield* triggerScheduledRun(
        now,
        env.SCHEDULED_DOWNLOADS,
      ).pipe(
        Effect.provide(D1ScheduleStoreLive(env.MARKET_DATA_DB)),
        Effect.result,
      );
      if (trigger._tag === "Success") {
        if (trigger.success.status === "started") {
          yield* Effect.logInfo("schedule_run_started").pipe(
            Effect.annotateLogs({
              runId: trigger.success.runId,
            }),
          );
        }
      } else {
        // The run is forgotten, so the next hourly tick tries again.
        yield* Effect.logError("schedule_run_failed").pipe(
          Effect.annotateLogs({
            message: trigger.failure.message,
          }),
        );
      }

      // Fail calculation runs whose Workflow stopped without reporting back.
      const sweep = yield* failStoppedRuns(env.CALCULATION_RUNS, now).pipe(
        Effect.provide(D1CalculationsLive(env.MARKET_DATA_DB)),
        Effect.result,
      );
      if (sweep._tag === "Success" && sweep.success > 0) {
        yield* Effect.logInfo("calculation_runs_failed_as_stopped").pipe(
          Effect.annotateLogs({
            count: sweep.success,
          }),
        );
      } else if (sweep._tag === "Failure") {
        yield* Effect.logError("calculation_run_sweep_failed").pipe(
          Effect.annotateLogs({
            message: sweep.failure.message,
          }),
        );
      }

      // Start calculations whose cron has fired since their last scheduled run.
      const calculations = yield* triggerScheduledCalculations(
        now,
        env.CALCULATION_RUNS,
      ).pipe(
        Effect.provide(D1CalculationsLive(env.MARKET_DATA_DB)),
        Effect.result,
      );
      if (calculations._tag === "Success") {
        for (const run of calculations.success) {
          if ("error" in run)
            yield* Effect.logError("calculation_schedule_failed").pipe(
              Effect.annotateLogs({ ...run }),
            );
          else
            yield* Effect.logInfo("calculation_run_scheduled").pipe(
              Effect.annotateLogs({ ...run }),
            );
        }
      } else {
        yield* Effect.logError("calculation_schedule_failed").pipe(
          Effect.annotateLogs({
            message: calculations.failure.message,
          }),
        );
      }

      // Dispatch workflow assignments at their definitions' daily hour. Off
      // (WORKFLOW_DISPATCH "off") until the download cutover: the legacy
      // scheduled download above still owns automatic downloads.
      const dispatch = yield* Effect.tryPromise(() =>
        startScheduledWorkflowTick(env, now, env.WORKFLOW_DISPATCHES),
      ).pipe(Effect.result);
      if (dispatch._tag === "Success") {
        if (dispatch.success.status === "started")
          yield* Effect.logInfo("workflow_dispatch_started").pipe(
            Effect.annotateLogs({ id: dispatch.success.id }),
          );
      } else {
        // Nothing claimed is lost: the next tick dispatches what is still due.
        const error = dispatch.failure.cause;
        yield* Effect.logError("workflow_dispatch_failed").pipe(
          Effect.annotateLogs({
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }

      if (now.getUTCHours() === PROCESSING_SWEEP_HOUR) {
        yield* scheduleProcessing(env.PROCESSING_QUEUE, now).pipe(
          Effect.provide(D1MarketDataControlPlaneLive(env.MARKET_DATA_DB)),
        );
      }
    }).pipe(Effect.provide(WorkerLoggerLive), Effect.runPromise);
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
