import { Effect, Layer, Result, Schema } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";

import { type AccessKeys, type AccessVariables, remoteAccessKeys, requireAccessUser } from "$/auth";
import { effectValidator } from "$/effect-validator";
import { DatasetSchema, MarketSymbolSchema } from "$/market-data/schemas";
import {
  CursorSchema,
  type DashboardUser,
  MAX_RUN_PAGE_SIZE,
  PipelineStatus,
  type PipelineStatusError,
  type RunPage,
  type SymbolStatusView,
} from "$/market-data/status";

const DEFAULT_RUN_PAGE_SIZE = 50;

const RunsQuerySchema = Schema.Struct({
  dataset: Schema.optionalKey(DatasetSchema),
  symbol: Schema.optionalKey(MarketSymbolSchema),
  status: Schema.optionalKey(Schema.Literals(["fetching", "completed", "failed"])),
  cursor: Schema.optionalKey(CursorSchema),
  limit: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^[1-9]\d*$/u, { message: "Expected a positive integer" }),
      Schema.makeFilter((value) => Number(value) <= MAX_RUN_PAGE_SIZE || `At most ${MAX_RUN_PAGE_SIZE}`),
    ),
  ),
});

const SymbolsQuerySchema = Schema.Struct({
  dataset: Schema.optionalKey(DatasetSchema),
  enabled: Schema.optionalKey(Schema.Literals(["true", "false"])),
});

type DashboardEnv = { Bindings: CloudflareBindings; Variables: AccessVariables };

/**
 * The dashboard: a Svelte app served from static assets, and a read-only API
 * under `/api`. Every request needs a Cloudflare Access user on the allowlist.
 */
export const createDashboardRoutes = (
  statusFor: (env: CloudflareBindings) => Layer.Layer<PipelineStatus>,
  keysFor: AccessKeys = remoteAccessKeys,
) => {
  const app = new Hono<DashboardEnv>();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );
  app.use("*", requireAccessUser(keysFor));

  const run = async <A>(env: CloudflareBindings, program: Effect.Effect<A, PipelineStatusError, PipelineStatus>) => {
    const result = await program.pipe(Effect.provide(statusFor(env)), Effect.result, Effect.runPromise);
    if (Result.isFailure(result)) {
      throw new HTTPException(500, { res: Response.json({ error: result.failure.message }, { status: 500 }) });
    }
    return result.success;
  };

  const api = new Hono<DashboardEnv>();
  api.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  api.get("/me", (c) => c.json<DashboardUser>({ email: c.get("accessEmail") }));

  api.get("/runs", effectValidator("query", RunsQuerySchema, { onExcessProperty: "error" }), async (c) => {
    const { limit, ...filter } = c.req.valid("query");
    const page = await run(
      c.env,
      PipelineStatus.use((status) =>
        status.listRuns({ ...filter, limit: limit === undefined ? DEFAULT_RUN_PAGE_SIZE : Number(limit) }),
      ),
    );
    return c.json<RunPage>(page);
  });

  api.get("/symbols", effectValidator("query", SymbolsQuerySchema, { onExcessProperty: "error" }), async (c) => {
    const query = c.req.valid("query");
    const symbols = await run(
      c.env,
      PipelineStatus.use((status) =>
        status.listSymbols({
          ...(query.dataset === undefined ? {} : { dataset: query.dataset }),
          ...(query.enabled === undefined ? {} : { enabled: query.enabled === "true" }),
        }),
      ),
    );
    return c.json<{ symbols: readonly SymbolStatusView[] }>({ symbols });
  });

  api.all("*", (c) => c.json({ error: "Not found" }, 404));

  app.route("/api", api);

  // Everything else is the app's static files. Copy the response so the
  // security headers can be added to it.
  app.get("*", async (c) => {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    return new Response(asset.body, asset);
  });

  return app;
};
