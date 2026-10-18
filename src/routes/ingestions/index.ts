import { Effect, Layer, Result, Schema } from "effect";
import { Hono } from "hono";

import { requireManagementToken } from "$/auth";
import { effectValidator } from "$/effect-validator";
import { MAX_INGESTION_ENTRIES, requestIngestions } from "$/market-data/ingestion-queue";
import { DatasetSchema, MarketSymbolSchema } from "$/market-data/schemas";
import { SymbolRegistry } from "$/market-data/symbol-registry";

const IngestionRequestSchema = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ dataset: DatasetSchema, symbol: MarketSymbolSchema })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_INGESTION_ENTRIES),
  ),
});

/** Manual ingestion: download registered symbols now instead of waiting for a schedule. */
export const createIngestionRoutes = (registryFor: (env: CloudflareBindings) => Layer.Layer<SymbolRegistry>) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", requireManagementToken);

  // Queue a full-history download for each entry, followed by its Parquet rebuild.
  app.post("/", effectValidator("json", IngestionRequestSchema, { onExcessProperty: "error" }), async (c) => {
    const { entries } = c.req.valid("json");
    const result = await requestIngestions(entries, c.env.INGESTION_QUEUE, new Date()).pipe(
      Effect.provide(registryFor(c.env)),
      Effect.result,
      Effect.runPromise,
    );
    if (Result.isFailure(result)) return c.json({ error: result.failure.message }, 500);
    if (result.success.status === "rejected") {
      return c.json({ error: "Some entries cannot be ingested", rejected: result.success.rejected }, 400);
    }
    return c.json({ queued: result.success.queued }, 202);
  });

  return app;
};
