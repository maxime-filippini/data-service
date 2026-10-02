import { Effect, Layer, Result } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { effectValidator } from "$/effect-validator";
import { MarketDataLive, retrieveDailyMarketData } from "$/market-data";
import { EodhdMarketDataSourceLive } from "$/market-data/eodhd";
import { R2MarketDataCacheLive } from "$/market-data/r2-cache";
import {
  MarketDataQuerySchema,
  type MarketDataRequest,
} from "$/market-data/schemas";

type Bindings = CloudflareBindings & {
  readonly EODHD_API_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

/** Run the provider-neutral program using the EODHD production adapter. */
const runEodhdMarketData = (
  request: MarketDataRequest,
  apiToken: unknown,
  bucket: R2Bucket,
) =>
  retrieveDailyMarketData(request).pipe(
    Effect.provide(
      MarketDataLive.pipe(
        Layer.provide(
          Layer.merge(
            EodhdMarketDataSourceLive(apiToken),
            R2MarketDataCacheLive(bucket),
          ),
        ),
      ),
    ),
    Effect.result,
    Effect.runPromise,
  );

app.get(
  "/market-data",
  effectValidator("query", MarketDataQuerySchema),
  async (c) => {
    const result = await runEodhdMarketData(
      c.req.valid("query"),
      c.env.EODHD_API_TOKEN,
      c.env.MARKET_DATA_BUCKET,
    );

    if (Result.isFailure(result)) {
      const status = result.failure.kind === "configuration" ? 500 : 502;

      throw new HTTPException(status, {
        res: c.json(
          {
            error: result.failure.message,
            symbol: result.failure.symbol ?? null,
          },
          status,
        ),
      });
    }

    return c.json(result.success);
  },
);

export default app;
