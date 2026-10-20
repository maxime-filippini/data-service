import { Effect, Layer } from "effect";
import { Hono } from "hono";

import { requireManagementToken } from "$/auth";
import { MarketDataError, MarketDataSource } from "$/market-data";
import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import { EodhdMarketDataSourceLive } from "$/market-data/eodhd";
import { type IngestionMessage, isRetryable, runIngestion } from "$/market-data/ingestion-queue";
import { processJob, scheduleProcessing } from "$/market-data/processing";
import { R2RawMarketDataStoreLive } from "$/market-data/r2-raw-store";
import { triggerScheduledRun } from "$/market-data/schedule";
import { D1ScheduleStoreLive } from "$/market-data/schedule/d1";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { D1PipelineStatusLive } from "$/market-data/status/d1";
import { D1PortfoliosLive } from "$/portfolios/d1";
import { createDashboardRoutes } from "$/routes/dashboard";
import { createIngestionRoutes } from "$/routes/ingestions";
import { createPortfolioRoutes } from "$/routes/portfolios";
import { createScheduleRoutes } from "$/routes/schedule";
import { createSymbolRoutes } from "$/routes/symbols";

export { MarketDataProcessor } from "./processor-container";
export { ScheduledDownloadWorkflow } from "./scheduled-download-workflow";

/** What the management API and the dashboard share. */
const services = {
  statusFor: (env: CloudflareBindings) => D1PipelineStatusLive(env.MARKET_DATA_DB),
  registryFor: (env: CloudflareBindings) => D1SymbolRegistryLive(env.MARKET_DATA_DB),
  storeFor: (env: CloudflareBindings) => D1ScheduleStoreLive(env.MARKET_DATA_DB),
  workflowFor: (env: CloudflareBindings) => env.SCHEDULED_DOWNLOADS,
  portfoliosFor: (env: CloudflareBindings) => D1PortfoliosLive(env.MARKET_DATA_DB),
};

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.route("/symbols", createSymbolRoutes(services.registryFor, requireManagementToken));
app.route("/ingestions", createIngestionRoutes(services.registryFor, requireManagementToken));
app.route("/schedule", createScheduleRoutes(services, requireManagementToken));
app.route("/portfolios", createPortfolioRoutes(services.portfoliosFor, requireManagementToken));
app.route("/dashboard", createDashboardRoutes(services));

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
