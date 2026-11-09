import { Effect, type Layer, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";

import { effectValidator } from "$/effect-validator";
import { runHttp } from "$/http/run-effect";
import {
  type ScheduleError,
  UpdateScheduleSchema,
} from "$/market-data/schedule/contracts";
import {
  type ScheduleWorkflow,
  scheduleView,
  startManualRun,
} from "$/market-data/schedule/operations";
import { ScheduleStore } from "$/market-data/schedule/store";

/**
 * Bounded dispatch-history count accepted from URL text; the route supplies
 * the default and converts to a number before calling the schedule store.
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
 * The daily download schedule: view and change it, see its runs, and run it
 * now. Served by the management API and the dashboard, each with its own auth.
 */
export const createScheduleRoutes = (
  dependencies: {
    readonly scheduleFor: (
      env: CloudflareBindings,
    ) => Layer.Layer<ScheduleStore>;
    readonly downloadWorkflowFor: (env: CloudflareBindings) => ScheduleWorkflow;
  },
  auth: MiddlewareHandler<{ Bindings: CloudflareBindings }>,
) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", auth);

  const run = <A>(
    env: CloudflareBindings,
    program: Effect.Effect<A, ScheduleError, ScheduleStore>,
  ) => runHttp(program, dependencies.scheduleFor(env));

  app.get("/", async (c) => c.json(await run(c.env, scheduleView(new Date()))));

  // Change the hour or pause the schedule. Omitted fields are kept.
  app.patch(
    "/",
    effectValidator("json", UpdateScheduleSchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const patch = c.req.valid("json");
      const now = new Date();
      const view = await run(
        c.env,
        ScheduleStore.use((store) =>
          store.update(patch, now.toISOString()),
        ).pipe(Effect.andThen(scheduleView(now))),
      );
      return c.json(view);
    },
  );

  app.get(
    "/runs",
    effectValidator("query", RunsQuerySchema, { onExcessProperty: "error" }),
    async (c) => {
      const { limit } = c.req.valid("query");
      const runs = await run(
        c.env,
        ScheduleStore.use((store) =>
          store.listRuns(limit === undefined ? 20 : Number(limit)),
        ),
      );
      return c.json({ runs });
    },
  );

  // Run the schedule now: queue a download for every enabled symbol.
  app.post("/runs", async (c) => {
    const started = await run(
      c.env,
      startManualRun(new Date(), dependencies.downloadWorkflowFor(c.env)),
    );
    return c.json(started, 202);
  });

  return app;
};
