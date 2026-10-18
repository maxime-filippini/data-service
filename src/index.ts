import { Effect } from "effect";
import { Hono } from "hono";

import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import { processJob, scheduleProcessing } from "$/market-data/processing";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { createSymbolRoutes } from "$/routes/symbols";

export { MarketDataProcessor } from "./processor-container";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.route("/symbols", createSymbolRoutes((env) => D1SymbolRegistryLive(env.MARKET_DATA_DB)));

export default {
  fetch: app.fetch,

  async scheduled(controller, env) {
    await scheduleProcessing(env.PROCESSING_QUEUE, new Date(controller.scheduledTime)).pipe(
      Effect.provide(D1MarketDataControlPlaneLive(env.MARKET_DATA_DB)),
      Effect.runPromise,
    );
  },

  async queue(batch, env) {
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
