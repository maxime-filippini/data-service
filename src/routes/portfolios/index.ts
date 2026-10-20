import { Effect, Layer, Result, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import { effectValidator } from "$/effect-validator";
import { MarketDateSchema } from "$/market-data/schemas";
import {
  CreatePortfolioSchema,
  NewSnapshotSchema,
  type PortfolioError,
  PortfolioIdSchema,
  Portfolios,
  RenamePortfolioSchema,
} from "$/portfolios";

const IdParamSchema = Schema.Struct({ id: PortfolioIdSchema });
const SnapshotParamSchema = Schema.Struct({ id: PortfolioIdSchema, holdingsDate: MarketDateSchema });

export const portfolioStatusOf = {
  not_found: 404,
  conflict: 409,
  untracked_symbols: 400,
  no_holdings: 422,
  database: 500,
} as const satisfies Record<PortfolioError["kind"], number>;

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

  const run = async <A>(env: CloudflareBindings, program: Effect.Effect<A, PortfolioError, Portfolios>) => {
    const result = await program.pipe(Effect.provide(portfoliosFor(env)), Effect.result, Effect.runPromise);
    if (Result.isFailure(result)) {
      const { kind, message, symbols, calculations } = result.failure;
      const status = portfolioStatusOf[kind];
      const extra = { ...(symbols === undefined ? {} : { symbols }), ...(calculations === undefined ? {} : { calculations }) };
      throw new HTTPException(status, { res: Response.json({ error: message, ...extra }, { status }) });
    }
    return result.success;
  };

  app.get("/", async (c) => {
    const portfolios = await run(c.env, Portfolios.use((store) => store.list()));
    return c.json({ portfolios });
  });

  // Create a portfolio, optionally with its first snapshot.
  app.post("/", effectValidator("json", CreatePortfolioSchema, { onExcessProperty: "error" }), async (c) => {
    const input = c.req.valid("json");
    const portfolio = await run(
      c.env,
      Portfolios.use((store) => store.create(input, crypto.randomUUID(), new Date().toISOString())),
    );
    return c.json(portfolio, 201);
  });

  app.get("/:id", effectValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await run(c.env, Portfolios.use((store) => store.get(id))));
  });

  app.patch(
    "/:id",
    effectValidator("param", IdParamSchema),
    effectValidator("json", RenamePortfolioSchema, { onExcessProperty: "error" }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { name } = c.req.valid("json");
      return c.json(await run(c.env, Portfolios.use((store) => store.rename(id, name, new Date().toISOString()))));
    },
  );

  // A portfolio a calculation uses can't be deleted (409, with the calculations).
  app.delete("/:id", effectValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    await run(c.env, Portfolios.use((store) => store.remove(id)));
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
        Portfolios.use((store) => store.addSnapshot(id, snapshot, new Date().toISOString())),
      );
      return c.json(added, 201);
    },
  );

  // Snapshots can't be edited: delete one and add it again.
  app.delete("/:id/snapshots/:holdingsDate", effectValidator("param", SnapshotParamSchema), async (c) => {
    const { id, holdingsDate } = c.req.valid("param");
    await run(c.env, Portfolios.use((store) => store.removeSnapshot(id, holdingsDate, new Date().toISOString())));
    return c.body(null, 204);
  });

  return app;
};
