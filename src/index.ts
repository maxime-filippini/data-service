import { Hono } from "hono";

import { D1MarketDataControlPlaneLive } from "$/market-data/control-plane/d1";
import { createProcessingRoutes } from "$/routes/processing";
import { createMarketDataRoutes } from "./routes/market-data";

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

export default app;
