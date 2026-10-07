import { effectValidator } from "$/effect-validator";
import { MarketDataLive, retrieveDailyMarketData } from "$/market-data";
import { EodhdMarketDataSourceLive } from "$/market-data/eodhd";
import {
  MarketDataQuerySchema,
  MarketDataRequest,
} from "$/market-data/schemas";
import { Effect, Layer, Result } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

type MarketDataBindings = Pick<CloudflareBindings, "EODHD_API_TOKEN">;

type AppEnvironment = { Bindings: MarketDataBindings };

/** Run the provider-neutral program using the EODHD production adapter. */
const runEodhdMarketData = (
  request: MarketDataRequest,
  apiToken: unknown,
) =>
  retrieveDailyMarketData(request).pipe(
    Effect.provide(
      MarketDataLive.pipe(
        Layer.provide(EodhdMarketDataSourceLive(apiToken)),
      ),
    ),
    Effect.result,
    Effect.runPromise,
  );

export const createMarketDataRoutes = () => {
  const app = new Hono<AppEnvironment>();

  app.get(
    "/eodhd",
    effectValidator("query", MarketDataQuerySchema),
    async (c) => {
      const result = await runEodhdMarketData(
        c.req.valid("query"),
        c.env.EODHD_API_TOKEN,
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

  return app;
};
