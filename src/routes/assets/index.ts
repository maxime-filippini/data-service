import { type Effect, type Layer, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";

import {
  type AssetError,
  AssetSymbolSchema,
  CreateAssetSchema,
  UpdateAssetSchema,
} from "$/assets/contracts";
import { Assets } from "$/assets/store";
import { effectValidator } from "$/effect-validator";
import { runHttp } from "$/http/run-effect";

/** The asset a detail or mutation route acts on. */
const SymbolParamSchema = Schema.Struct({ symbol: AssetSymbolSchema });

/**
 * Assets, identified by symbol. Served by the management API and the app,
 * each with its own auth. Creating an asset downloads nothing and creates no
 * portfolio; deleting one removes its workflow assignments.
 */
export const createAssetRoutes = (
  assetsFor: (env: CloudflareBindings) => Layer.Layer<Assets>,
  auth: MiddlewareHandler<{ Bindings: CloudflareBindings }>,
) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", auth);

  const run = <A>(
    env: CloudflareBindings,
    program: Effect.Effect<A, AssetError, Assets>,
  ) => runHttp(program, assetsFor(env));

  app.get("/", async (c) => {
    const assets = await run(
      c.env,
      Assets.use((store) => store.list()),
    );
    return c.json({ assets });
  });

  app.post(
    "/",
    effectValidator("json", CreateAssetSchema, { onExcessProperty: "error" }),
    async (c) => {
      const input = c.req.valid("json");
      const asset = await run(
        c.env,
        Assets.use((store) => store.create(input, new Date().toISOString())),
      );
      return c.json(asset, 201);
    },
  );

  app.get(
    "/:symbol",
    effectValidator("param", SymbolParamSchema),
    async (c) => {
      const { symbol } = c.req.valid("param");
      return c.json(
        await run(
          c.env,
          Assets.use((store) => store.get(symbol)),
        ),
      );
    },
  );

  app.patch(
    "/:symbol",
    effectValidator("param", SymbolParamSchema),
    effectValidator("json", UpdateAssetSchema, { onExcessProperty: "error" }),
    async (c) => {
      const { symbol } = c.req.valid("param");
      const input = c.req.valid("json");
      return c.json(
        await run(
          c.env,
          Assets.use((store) =>
            store.update(symbol, input, new Date().toISOString()),
          ),
        ),
      );
    },
  );

  app.delete(
    "/:symbol",
    effectValidator("param", SymbolParamSchema),
    async (c) => {
      const { symbol } = c.req.valid("param");
      await run(
        c.env,
        Assets.use((store) => store.remove(symbol)),
      );
      return c.body(null, 204);
    },
  );

  return app;
};
