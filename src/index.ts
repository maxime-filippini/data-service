import { Effect, Layer } from "effect";

import { D1CalculationsLive } from "$/calculations/d1";
import { failStoppedRuns } from "$/calculations/runs";
import { triggerScheduledCalculations } from "$/calculations/schedule";
import { MarketDataError, MarketDataSource } from "$/market-data";
import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import { EodhdMarketDataSourceLive } from "$/market-data/eodhd";
import { type IngestionMessage, isRetryable, runIngestion } from "$/market-data/ingestion-queue";
import { processJob, scheduleProcessing } from "$/market-data/processing";
import { R2RawMarketDataStoreLive } from "$/market-data/r2-raw-store";
import { triggerScheduledRun } from "$/market-data/schedule";
import { D1ScheduleStoreLive } from "$/market-data/schedule/d1";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { createRoutes } from "$/routes";
import { services } from "$/services";
// SvelteKit's handler, built by `pnpm --filter app build` (wrangler's build
// command runs it before dev and deploy). It has no type declarations.
// @ts-expect-error -- generated JavaScript, missing until the app is built
import sveltekit from "../app/.svelte-kit/cloudflare/_worker.js";

export { CalculationRunWorkflow } from "./calculation-run-workflow";
export { CalculationEngine } from "./engine-container";
export { MarketDataProcessor } from "./processor-container";
export { ScheduledDownloadWorkflow } from "./scheduled-download-workflow";

const app = createRoutes(services, sveltekit);

/** The hour (UTC) at which the cron resends queued Parquet rebuilds. */
const PROCESSING_SWEEP_HOUR = 2;

/** The download adapter for a tracked symbol's provider. */
const sourceFor = (env: CloudflareBindings) => (provider: string) =>
  provider === "eodhd"
    ? EodhdMarketDataSourceLive(env.EODHD_API_TOKEN)
    : Layer.effect(
        MarketDataSource,
        Effect.fail(new MarketDataError({ kind: "configuration", message: `Unknown provider ${provider}` })),
      );

const ingest = async (batch: MessageBatch<IngestionMessage>, env: CloudflareBindings) => {
  const layer = Layer.mergeAll(
    D1SymbolRegistryLive(env.MARKET_DATA_DB),
    D1MarketDataControlPlaneLive(env.MARKET_DATA_DB),
    R2RawMarketDataStoreLive(env.MARKET_DATA_BUCKET),
  );
  const dependencies = { sourceFor: sourceFor(env), processingQueue: env.PROCESSING_QUEUE };

  for (const message of batch.messages) {
    const { dataset, symbol } = message.body;
    const result = await runIngestion(message.body, dependencies).pipe(
      Effect.provide(layer),
      Effect.result,
      Effect.runPromise,
    );
    if (result._tag === "Success") {
      console.log(JSON.stringify({ event: "ingestion", dataset, symbol, ...result.success }));
      message.ack();
    } else {
      const retry = isRetryable(result.failure);
      console.error(
        JSON.stringify({
          event: "ingestion_failed",
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
};

export default {
  fetch: app.fetch,

  async scheduled(controller, env) {
    const now = new Date(controller.scheduledTime);

    const trigger = await triggerScheduledRun(now, env.SCHEDULED_DOWNLOADS).pipe(
      Effect.provide(D1ScheduleStoreLive(env.MARKET_DATA_DB)),
      Effect.result,
      Effect.runPromise,
    );
    if (trigger._tag === "Success") {
      if (trigger.success.status === "started") {
        console.log(JSON.stringify({ event: "schedule_run_started", runId: trigger.success.runId }));
      }
    } else {
      // The run is forgotten, so the next hourly tick tries again.
      console.error(JSON.stringify({ event: "schedule_run_failed", message: trigger.failure.message }));
    }

    // Fail calculation runs whose Workflow stopped without reporting back.
    const sweep = await failStoppedRuns(env.CALCULATION_RUNS, now).pipe(
      Effect.provide(D1CalculationsLive(env.MARKET_DATA_DB)),
      Effect.result,
      Effect.runPromise,
    );
    if (sweep._tag === "Success" && sweep.success > 0) {
      console.log(JSON.stringify({ event: "calculation_runs_failed_as_stopped", count: sweep.success }));
    } else if (sweep._tag === "Failure") {
      console.error(JSON.stringify({ event: "calculation_run_sweep_failed", message: sweep.failure.message }));
    }

    // Start calculations whose cron has fired since their last scheduled run.
    const calculations = await triggerScheduledCalculations(now, env.CALCULATION_RUNS).pipe(
      Effect.provide(D1CalculationsLive(env.MARKET_DATA_DB)),
      Effect.result,
      Effect.runPromise,
    );
    if (calculations._tag === "Success") {
      for (const run of calculations.success) {
        if ("error" in run) console.error(JSON.stringify({ event: "calculation_schedule_failed", ...run }));
        else console.log(JSON.stringify({ event: "calculation_run_scheduled", ...run }));
      }
    } else {
      console.error(JSON.stringify({ event: "calculation_schedule_failed", message: calculations.failure.message }));
    }

    if (now.getUTCHours() === PROCESSING_SWEEP_HOUR) {
      await scheduleProcessing(env.PROCESSING_QUEUE, now).pipe(
        Effect.provide(D1MarketDataControlPlaneLive(env.MARKET_DATA_DB)),
        Effect.runPromise,
      );
    }
  },

  async queue(batch, env) {
    if (batch.queue === env.INGESTION_QUEUE_NAME) {
      await ingest(batch as MessageBatch<IngestionMessage>, env);
      return;
    }

    const controlPlane = D1MarketDataControlPlaneLive(env.MARKET_DATA_DB);
    const processor = env.MARKET_DATA_PROCESSOR.getByName("processor");

    for (const message of batch.messages) {
      const body = message.body as { jobId?: unknown };
      if (typeof body?.jobId !== "string") {
        console.error(JSON.stringify({ event: "invalid_processing_message", messageId: message.id }));
        message.ack();
        continue;
      }

      const result = await processJob(body.jobId, processor).pipe(
        Effect.provide(controlPlane),
        Effect.result,
        Effect.runPromise,
      );
      if (result._tag === "Success") {
        console.log(JSON.stringify({ event: "processing_job", jobId: body.jobId, outcome: result.success }));
        message.ack();
      } else {
        console.error(JSON.stringify({ event: "processing_retry", jobId: body.jobId, error: result.failure._tag }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<CloudflareBindings>;
