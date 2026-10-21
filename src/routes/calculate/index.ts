import { Effect, Layer, Result } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import { AdHocCalculationSchema, calculateAdHoc } from "$/calculations/ad-hoc";
import { Engine, type EngineError } from "$/calculations/engine";
import { effectValidator } from "$/effect-validator";
import type { PortfolioError, Portfolios } from "$/portfolios";
import { portfolioStatusOf } from "$/routes/portfolios";

type Env = { Bindings: CloudflareBindings };

export const engineStatusOf = {
  not_found: 404,
  invalid: 422,
  failed: 500,
  unavailable: 503,
  timeout: 504,
} as const satisfies Record<EngineError["kind"], number>;

/** Runs a program, turning engine and portfolio errors into JSON error responses. */
const runWith = async <A, R>(
  layer: Layer.Layer<R>,
  program: Effect.Effect<A, EngineError | PortfolioError, R>,
) => {
  const result = await program.pipe(Effect.provide(layer), Effect.result, Effect.runPromise);
  if (Result.isFailure(result)) {
    const error = result.failure;
    const status = error._tag === "EngineError" ? engineStatusOf[error.kind] : portfolioStatusOf[error.kind];
    const extra =
      error._tag === "EngineError"
        ? error.detail === undefined ? {} : { detail: error.detail }
        : error.symbols === undefined ? {} : { symbols: error.symbols };
    throw new HTTPException(status, { res: Response.json({ error: error.message, ...extra }, { status }) });
  }
  return result.success;
};

/**
 * `GET /calculation-types`: the engine's calculation types, with their params
 * JSON Schema and output columns. Served by the management API and the
 * dashboard, each with its own auth.
 */
export const createCalculationTypeRoutes = (
  engineFor: (env: CloudflareBindings) => Layer.Layer<Engine>,
  auth: MiddlewareHandler<Env>,
) => {
  const app = new Hono<Env>();
  app.use("*", auth);

  app.get("/", async (c) => {
    const types = await runWith(engineFor(c.env), Engine.use((engine) => engine.listTypes()));
    return c.json({ types });
  });

  return app;
};

/**
 * `POST /calculate`: an ad hoc calculation, returned in the response and not
 * saved. JSON by default, or an Arrow IPC stream with
 * `Accept: application/vnd.apache.arrow.stream`.
 */
export const createCalculateRoutes = (
  services: {
    readonly engineFor: (env: CloudflareBindings) => Layer.Layer<Engine>;
    readonly portfoliosFor: (env: CloudflareBindings) => Layer.Layer<Portfolios>;
  },
  auth: MiddlewareHandler<Env>,
) => {
  const app = new Hono<Env>();
  app.use("*", auth);

  app.post("/", effectValidator("json", AdHocCalculationSchema, { onExcessProperty: "error" }), async (c) => {
    const response = await runWith(
      Layer.merge(services.engineFor(c.env), services.portfoliosFor(c.env)),
      calculateAdHoc(c.req.valid("json"), new Date(), c.req.header("Accept")),
    );
    return new Response(response.body, {
      headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
    });
  });

  return app;
};
