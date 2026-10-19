import { Effect, Layer, Result, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";

import { type AccessKeys, type AccessVariables, remoteAccessKeys, requireAccessUser } from "$/auth";
import { effectValidator } from "$/effect-validator";
import type { ScheduleStore, ScheduleWorkflow } from "$/market-data/schedule";
import { canonicalKey, DatasetSchema, datasetProviders, MarketSymbolSchema } from "$/market-data/schemas";
import {
  CursorSchema,
  type DashboardUser,
  MAX_RUN_PAGE_SIZE,
  PipelineStatus,
  type PipelineStatusError,
  type RunPage,
  type SymbolStatusView,
} from "$/market-data/status";
import type { SymbolRegistry } from "$/market-data/symbol-registry";
import { createIngestionRoutes } from "$/routes/ingestions";
import { createScheduleRoutes } from "$/routes/schedule";
import { createSymbolRoutes } from "$/routes/symbols";

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

const DatasetParamsSchema = Schema.Struct({
  dataset: DatasetSchema,
  symbol: MarketSymbolSchema,
});

type DashboardEnv = { Bindings: CloudflareBindings; Variables: AccessVariables };

/** Passes every request; the dashboard has already checked Access. */
const accessChecked: MiddlewareHandler = (_, next) => next();

/**
 * Browsers send the Access cookie with cross-site requests too, so changes
 * must come from the dashboard's own pages. JSON bodies already force a CORS
 * preflight, which nothing answers; this also covers bodiless POSTs.
 */
const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    const sameOrigin = origin === new URL(c.req.url).origin || c.req.header("Sec-Fetch-Site") === "same-origin";
    if (!sameOrigin) return c.json({ error: "Cross-site requests are not allowed" }, 403);
  }
  await next();
};

/**
 * The dashboard: a Svelte app served from static assets, and an API under
 * `/api`. Every request needs a Cloudflare Access user on the allowlist.
 * Besides reading pipeline status, it can edit the registry and the schedule
 * and start downloads, through the same routes as the management API.
 */
export const createDashboardRoutes = (
  services: {
    readonly statusFor: (env: CloudflareBindings) => Layer.Layer<PipelineStatus>;
    readonly registryFor: (env: CloudflareBindings) => Layer.Layer<SymbolRegistry>;
    readonly storeFor: (env: CloudflareBindings) => Layer.Layer<ScheduleStore>;
    readonly workflowFor: (env: CloudflareBindings) => ScheduleWorkflow;
  },
  keysFor: AccessKeys = remoteAccessKeys,
) => {
  const { statusFor } = services;
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
  api.use("*", requireSameOrigin);
  api.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
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

  // The canonical Parquet file, streamed from R2 for the dataset explorer.
  // The browser keeps a copy and revalidates it with the ETag, so the file is
  // only downloaded again after a rebuild.
  api.get(
    "/datasets/:dataset/:symbol",
    effectValidator("param", DatasetParamsSchema, { onExcessProperty: "error" }),
    async (c) => {
      const { dataset, symbol } = c.req.valid("param");
      const cachedEtag = c.req.header("If-None-Match")?.replace(/^W\//u, "").replaceAll('"', "");
      const object = await c.env.PROCESSED_MARKET_DATA_BUCKET.get(
        canonicalKey(dataset, symbol),
        cachedEtag === undefined ? {} : { onlyIf: { etagDoesNotMatch: cachedEtag } },
      );
      if (object === null) return c.json({ error: "No data has been built for this symbol yet" }, 404);

      const headers = new Headers({
        "Cache-Control": "private, no-cache",
        ETag: object.httpEtag,
        "Last-Modified": object.uploaded.toUTCString(),
      });
      if (!("body" in object)) return new Response(null, { status: 304, headers });

      headers.set("Content-Type", "application/vnd.apache.parquet");
      headers.set("Content-Length", String(object.size));
      return new Response(object.body, { headers });
    },
  );

  // Choices for the registry form.
  api.get("/options", (c) => c.json({ datasetProviders }));

  api.route("/registry", createSymbolRoutes(services.registryFor, accessChecked));
  api.route("/ingestions", createIngestionRoutes(services.registryFor, accessChecked));
  api.route("/schedule", createScheduleRoutes(services, accessChecked));

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
