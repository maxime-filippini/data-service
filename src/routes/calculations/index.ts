import { Effect, Layer, Result, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  type CalculationError,
  CalculationIdSchema,
  Calculations,
  CreateCalculationSchema,
  RunIdSchema,
  StartRunSchema,
  UpdateCalculationSchema,
} from "$/calculations";
import { createCalculation, updateCalculation } from "$/calculations/configure";
import type { Engine, EngineError } from "$/calculations/engine";
import { type RunWorkflow, startRun } from "$/calculations/runs";
import { effectValidator } from "$/effect-validator";
import { previousDay } from "$/market-data/ingestion-queue";
import { engineStatusOf } from "$/routes/calculate";

type Env = { Bindings: CloudflareBindings };

const IdParamSchema = Schema.Struct({ id: CalculationIdSchema });
const RunParamSchema = Schema.Struct({ id: CalculationIdSchema, runId: RunIdSchema });

const RunsQuerySchema = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^[1-9]\d*$/u, { message: "Expected a positive integer" }),
      Schema.makeFilter((value) => Number(value) <= 100 || "At most 100"),
    ),
  ),
});

export const calculationStatusOf = {
  not_found: 404,
  invalid: 422,
  workflow: 500,
  database: 500,
} as const satisfies Record<CalculationError["kind"], number>;

/**
 * Saved calculations and their runs: create, change and delete calculations,
 * start a run now and see past runs. Served by the management API and the
 * dashboard, each with its own auth.
 */
export const createCalculationRoutes = (
  services: {
    readonly calculationsFor: (env: CloudflareBindings) => Layer.Layer<Calculations>;
    readonly engineFor: (env: CloudflareBindings) => Layer.Layer<Engine>;
    readonly runWorkflowFor: (env: CloudflareBindings) => RunWorkflow;
  },
  auth: MiddlewareHandler<Env>,
) => {
  const app = new Hono<Env>();
  app.use("*", auth);

  const run = async <A>(
    env: CloudflareBindings,
    program: Effect.Effect<A, CalculationError | EngineError, Calculations | Engine>,
  ) => {
    const layer = Layer.merge(services.calculationsFor(env), services.engineFor(env));
    const result = await program.pipe(Effect.provide(layer), Effect.result, Effect.runPromise);
    if (Result.isFailure(result)) {
      const error = result.failure;
      const status = error._tag === "EngineError" ? engineStatusOf[error.kind] : calculationStatusOf[error.kind];
      const extra =
        error._tag === "EngineError"
          ? error.detail === undefined ? {} : { detail: error.detail }
          : error.portfolioIds === undefined ? {} : { portfolioIds: error.portfolioIds };
      throw new HTTPException(status, { res: Response.json({ error: error.message, ...extra }, { status }) });
    }
    return result.success;
  };

  app.get("/", async (c) => {
    const calculations = await run(c.env, Calculations.use((store) => store.list()));
    return c.json({ calculations });
  });

  // The engine checks the params; they're saved with defaults filled in.
  app.post("/", effectValidator("json", CreateCalculationSchema, { onExcessProperty: "error" }), async (c) => {
    const input = c.req.valid("json");
    const calculation = await run(c.env, createCalculation(input, crypto.randomUUID(), new Date().toISOString()));
    return c.json(calculation, 201);
  });

  app.get("/:id", effectValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await run(c.env, Calculations.use((store) => store.get(id))));
  });

  // Change the name, params, portfolios, cron or enabled flag. Omitted fields are kept.
  app.patch(
    "/:id",
    effectValidator("param", IdParamSchema),
    effectValidator("json", UpdateCalculationSchema, { onExcessProperty: "error" }),
    async (c) => {
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      return c.json(await run(c.env, updateCalculation(id, patch, new Date().toISOString())));
    },
  );

  // Deletes the calculation and its runs. Its results stay in R2.
  app.delete("/:id", effectValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    await run(c.env, Calculations.use((store) => store.remove(id)));
    return c.body(null, 204);
  });

  app.get(
    "/:id/runs",
    effectValidator("param", IdParamSchema),
    effectValidator("query", RunsQuerySchema, { onExcessProperty: "error" }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      const runs = await run(
        c.env,
        Calculations.use((store) =>
          store.get(id).pipe(Effect.andThen(store.listRuns(id, limit === undefined ? 20 : Number(limit)))),
        ),
      );
      return c.json({ runs });
    },
  );

  // Run now, as of `asOf` (default: the previous UTC day). Returns the run ID
  // straight away; the run is `skipped` if another one is still going.
  app.post(
    "/:id/runs",
    effectValidator("param", IdParamSchema),
    effectValidator("json", StartRunSchema, { onExcessProperty: "error" }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { asOf } = c.req.valid("json");
      const now = new Date();
      const started = await run(
        c.env,
        startRun(id, { trigger: "manual", asOf: asOf ?? previousDay(now) }, now, services.runWorkflowFor(c.env)),
      );
      return c.json(started, 202);
    },
  );

  app.get("/:id/runs/:runId", effectValidator("param", RunParamSchema), async (c) => {
    const { id, runId } = c.req.valid("param");
    const found = await run(c.env, Calculations.use((store) => store.getRun(runId)));
    if (found.calculationId !== id) return c.json({ error: "The run does not exist" }, 404);
    return c.json(found);
  });

  return app;
};
