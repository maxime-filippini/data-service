import { Hono } from "hono";

import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import { createProcessingRoutes } from "$/routes/processing";
import { createSymbolRoutes } from "$/routes/symbols";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { createMarketDataRoutes } from "./routes/market-data";
import { executeProcessingMessage, scheduleProcessing } from "$/market-data/processing-dispatch";

export { MarketDataProcessor } from "./processor-container";

type Bindings = CloudflareBindings & {
  readonly EODHD_API_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.route(
  "/processing-jobs",
  createProcessingRoutes((bindings) =>
    D1MarketDataControlPlaneLive(bindings.MARKET_DATA_DB),
  ),
);

app.route("/market-data", createMarketDataRoutes());
app.route("/symbols", createSymbolRoutes((bindings) => D1SymbolRegistryLive(bindings.MARKET_DATA_DB)));

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    await scheduleProcessing(
      env.MARKET_DATA_DB,
      env.PROCESSING_QUEUE,
      D1MarketDataControlPlaneLive(env.MARKET_DATA_DB),
      new Date(controller.scheduledTime).toISOString(),
    );
  },
  async queue(batch, env) {
    const controlPlane = D1MarketDataControlPlaneLive(env.MARKET_DATA_DB);
    for (const message of batch.messages) {
      try {
        await executeProcessingMessage(
          message.body, controlPlane,
          env.MARKET_DATA_PROCESSOR.getByName("processor"), env.PROCESSOR_API_TOKEN,
        );
        message.ack();
      } catch {
        console.error(JSON.stringify({ event: "processing_delivery_retry", messageId: message.id }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<CloudflareBindings>;
