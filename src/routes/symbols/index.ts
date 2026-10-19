import { Effect, Layer, Result, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import { effectValidator } from "$/effect-validator";
import { DatasetSchema, MarketSymbolSchema } from "$/market-data/schemas";
import {
  RegisterSymbolSchema,
  SymbolRegistry,
  type SymbolRegistryError,
} from "$/market-data/symbol-registry";

const ListQuerySchema = Schema.Struct({
  dataset: Schema.optionalKey(DatasetSchema),
  enabled: Schema.optionalKey(Schema.Literals(["true", "false"])),
});

const IdentitySchema = Schema.Struct({
  dataset: DatasetSchema,
  symbol: MarketSymbolSchema,
});

/**
 * The download universe: register, edit, and put symbols on or off the daily
 * schedule. Served by the management API and the dashboard, each with its own auth.
 */
export const createSymbolRoutes = (
  registryFor: (env: CloudflareBindings) => Layer.Layer<SymbolRegistry>,
  auth: MiddlewareHandler<{ Bindings: CloudflareBindings }>,
) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", auth);

  const run = async <A>(env: CloudflareBindings, program: Effect.Effect<A, SymbolRegistryError, SymbolRegistry>) => {
    const result = await program.pipe(Effect.provide(registryFor(env)), Effect.result, Effect.runPromise);
    if (Result.isFailure(result)) {
      const status = result.failure.kind === "not_found" ? 404 : 500;
      throw new HTTPException(status, {
        res: Response.json({ error: result.failure.message }, { status }),
      });
    }
    return result.success;
  };

  // Register or update a symbol. Re-registering a disabled symbol enables it.
  app.post("/", effectValidator("json", RegisterSymbolSchema, { onExcessProperty: "error" }), async (c) => {
    const input = c.req.valid("json");
    const { symbol, created } = await run(
      c.env,
      SymbolRegistry.use((registry) => registry.register(input, new Date().toISOString())),
    );
    return c.json(symbol, created ? 201 : 200);
  });

  app.get("/", effectValidator("query", ListQuerySchema, { onExcessProperty: "error" }), async (c) => {
    const query = c.req.valid("query");
    const symbols = await run(
      c.env,
      SymbolRegistry.use((registry) =>
        registry.list({
          ...(query.dataset === undefined ? {} : { dataset: query.dataset }),
          ...(query.enabled === undefined ? {} : { enabled: query.enabled === "true" }),
        }),
      ),
    );
    return c.json({ symbols });
  });

  // Take a symbol off, or put it back on, the daily schedule. Keeps run
  // history and the Parquet object.
  for (const [action, enabled] of [["disable", false], ["enable", true]] as const) {
    app.post(`/:dataset/:symbol/${action}`, effectValidator("param", IdentitySchema), async (c) => {
      const { dataset, symbol } = c.req.valid("param");
      const result = await run(
        c.env,
        SymbolRegistry.use((registry) => registry.setEnabled(dataset, symbol, enabled, new Date().toISOString())),
      );
      return c.json(result);
    });
  }

  return app;
};
