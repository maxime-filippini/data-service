import { Effect, type Layer, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";

import { effectValidator } from "$/effect-validator";
import { runHttp } from "$/http/run-effect";
import { MarketDateSchema } from "$/market-data/schemas";
import {
  CreatePortfolioSchema,
  NewSnapshotSchema,
  type PortfolioError,
  PortfolioIdSchema,
  RenamePortfolioSchema,
} from "$/portfolios/contracts";
import { Portfolios } from "$/portfolios/store";

/**
 * Saved-portfolio identity accepted by detail and mutation routes.
 */
const IdParamSchema = Schema.Struct({ id: PortfolioIdSchema });

/**
 * Identifies the complete dated holdings snapshot removed by a delete request.
 */
const SnapshotParamSchema = Schema.Struct({
  id: PortfolioIdSchema,
  holdingsDate: MarketDateSchema,
});

/**
 * Portfolios and their holdings snapshots. Snapshots are added or deleted,
 * never edited. Served by the management API and the dashboard, each with its
 * own auth.
 */
export const createPortfolioRoutes = (
  portfoliosFor: (env: CloudflareBindings) => Layer.Layer<Portfolios>,
  auth: MiddlewareHandler<{ Bindings: CloudflareBindings }>,
) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", auth);

  const run = <A>(
    env: CloudflareBindings,
    program: Effect.Effect<A, PortfolioError, Portfolios>,
  ) => runHttp(program, portfoliosFor(env));

  app.get("/", async (c) => {
    const portfolios = await run(
      c.env,
      Portfolios.use((store) => store.list()),
    );
    return c.json({ portfolios });
  });

  // Create a portfolio, optionally with its first snapshot.
  app.post(
    "/",
    effectValidator("json", CreatePortfolioSchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const input = c.req.valid("json");
      const portfolio = await run(
        c.env,
        Portfolios.use((store) =>
          store.create(input, crypto.randomUUID(), new Date().toISOString()),
        ),
      );
      return c.json(portfolio, 201);
    },
  );

  app.get("/:id", effectValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    return c.json(
      await run(
        c.env,
        Portfolios.use((store) => store.get(id)),
      ),
    );
  });

  app.patch(
    "/:id",
    effectValidator("param", IdParamSchema),
    effectValidator("json", RenamePortfolioSchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { name } = c.req.valid("json");
      return c.json(
        await run(
          c.env,
          Portfolios.use((store) =>
            store.rename(id, name, new Date().toISOString()),
          ),
        ),
      );
    },
  );

  // A portfolio a calculation uses can't be deleted (409, with the calculations).
  app.delete("/:id", effectValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    await run(
      c.env,
      Portfolios.use((store) => store.remove(id)),
    );
    return c.body(null, 204);
  });

  app.post(
    "/:id/snapshots",
    effectValidator("param", IdParamSchema),
    effectValidator("json", NewSnapshotSchema, { onExcessProperty: "error" }),
    async (c) => {
      const { id } = c.req.valid("param");
      const snapshot = c.req.valid("json");
      const added = await run(
        c.env,
        Portfolios.use((store) =>
          store.addSnapshot(id, snapshot, new Date().toISOString()),
        ),
      );
      return c.json(added, 201);
    },
  );

  // Snapshots can't be edited: delete one and add it again.
  app.delete(
    "/:id/snapshots/:holdingsDate",
    effectValidator("param", SnapshotParamSchema),
    async (c) => {
      const { id, holdingsDate } = c.req.valid("param");
      await run(
        c.env,
        Portfolios.use((store) =>
          store.removeSnapshot(id, holdingsDate, new Date().toISOString()),
        ),
      );
      return c.body(null, 204);
    },
  );

  return app;
};
