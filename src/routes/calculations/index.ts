import { Effect, Layer, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";

import { createCalculation, updateCalculation } from "$/calculations/configure";
import {
  type CalculationError,
  CalculationIdSchema,
  CreateCalculationSchema,
  RunIdSchema,
  StartRunSchema,
  UpdateCalculationSchema,
} from "$/calculations/contracts";
import type { Engine, EngineError } from "$/calculations/engine";
import { type RunWorkflow, startRun } from "$/calculations/runs";
import { Calculations } from "$/calculations/store";
import { effectValidator } from "$/effect-validator";
import { runHttp } from "$/http/run-effect";
import { previousDay } from "$/market-data/ingestion-queue";

type Env = { Bindings: CloudflareBindings };

/**
 * Saved-calculation identity accepted in detail and mutation route paths.
 */
const IdParamSchema = Schema.Struct({ id: CalculationIdSchema });

/**
 * Calculation/run path pair. Format validation is followed by an ownership
 * check so a run cannot be read through a different calculation's URL.
 */
const RunParamSchema = Schema.Struct({
  id: CalculationIdSchema,
  runId: RunIdSchema,
});

/**
 * Bounded history-page size read from URL text; the route applies its
 * default and converts to a number before querying runs.
 */
const RunsQuerySchema = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^[1-9]\d*$/u, {
        message: "Expected a positive integer",
      }),
      Schema.makeFilter((value) => Number(value) <= 100 || "At most 100"),
    ),
  ),
});

/**
 * Saved calculations and their runs: create, change and delete calculations,
 * start a run now and see past runs. Served by the management API and the
 * dashboard, each with its own auth.
 */
export const createCalculationRoutes = (
  dependencies: {
    readonly calculationsFor: (
      env: CloudflareBindings,
    ) => Layer.Layer<Calculations>;
    readonly engineFor: (env: CloudflareBindings) => Layer.Layer<Engine>;
    readonly runWorkflowFor: (env: CloudflareBindings) => RunWorkflow;
  },
  auth: MiddlewareHandler<Env>,
) => {
  const app = new Hono<Env>();
  app.use("*", auth);

  const run = <A>(
    env: CloudflareBindings,
    program: Effect.Effect<
      A,
      CalculationError | EngineError,
      Calculations | Engine
    >,
  ) =>
    runHttp(
      program,
      Layer.merge(
        dependencies.calculationsFor(env),
        dependencies.engineFor(env),
      ),
    );

  app.get("/", async (c) => {
    const calculations = await run(
      c.env,
      Calculations.use((store) => store.list()),
    );
    return c.json({ calculations });
  });

  // The engine checks the params; they're saved with defaults filled in.
  app.post(
    "/",
    effectValidator("json", CreateCalculationSchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const input = c.req.valid("json");
      const calculation = await run(
        c.env,
        createCalculation(input, crypto.randomUUID(), new Date().toISOString()),
      );
      return c.json(calculation, 201);
    },
  );

  app.get("/:id", effectValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    return c.json(
      await run(
        c.env,
        Calculations.use((store) => store.get(id)),
      ),
    );
  });

  // Change the name, params, portfolios, cron or enabled flag. Omitted fields are kept.
  app.patch(
    "/:id",
    effectValidator("param", IdParamSchema),
    effectValidator("json", UpdateCalculationSchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      return c.json(
        await run(
          c.env,
          updateCalculation(id, patch, new Date().toISOString()),
        ),
      );
    },
  );

  // Deletes the calculation and its runs. Its results stay in R2.
  app.delete("/:id", effectValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    await run(
      c.env,
      Calculations.use((store) => store.remove(id)),
    );
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
          store
            .get(id)
            .pipe(
              Effect.andThen(
                store.listRuns(id, limit === undefined ? 20 : Number(limit)),
              ),
            ),
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
        startRun(
          id,
          { trigger: "manual", asOf: asOf ?? previousDay(now) },
          now,
          dependencies.runWorkflowFor(c.env),
        ),
      );
      return c.json(started, 202);
    },
  );

  app.get(
    "/:id/runs/:runId",
    effectValidator("param", RunParamSchema),
    async (c) => {
      const { id, runId } = c.req.valid("param");
      const found = await run(
        c.env,
        Calculations.use((store) => store.getRun(runId)),
      );
      if (found.calculationId !== id)
        return c.json({ error: "The run does not exist" }, 404);
      return c.json(found);
    },
  );

  return app;
};
