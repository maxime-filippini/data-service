import { Effect, Layer } from "effect";
import { Hono, type MiddlewareHandler } from "hono";

import { AdHocCalculationSchema, calculateAdHoc } from "$/calculations/ad-hoc";
import { Engine } from "$/calculations/engine";
import { effectValidator } from "$/effect-validator";
import { runHttp } from "$/http/run-effect";
import type { Portfolios } from "$/portfolios/store";

type Env = { Bindings: CloudflareBindings };

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
    const types = await runHttp(
      Engine.use((engine) => engine.listTypes()),
      engineFor(c.env),
    );
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
  dependencies: {
    readonly engineFor: (env: CloudflareBindings) => Layer.Layer<Engine>;
    readonly portfoliosFor: (
      env: CloudflareBindings,
    ) => Layer.Layer<Portfolios>;
  },
  auth: MiddlewareHandler<Env>,
) => {
  const app = new Hono<Env>();
  app.use("*", auth);

  app.post(
    "/",
    effectValidator("json", AdHocCalculationSchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const response = await runHttp(
        calculateAdHoc(c.req.valid("json"), new Date(), c.req.header("Accept")),
        Layer.merge(
          dependencies.engineFor(c.env),
          dependencies.portfoliosFor(c.env),
        ),
      );
      return new Response(response.body, {
        headers: {
          "Content-Type":
            response.headers.get("Content-Type") ?? "application/json",
        },
      });
    },
  );

  return app;
};
