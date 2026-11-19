import { Effect, type Layer, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";

import { AssetSymbolSchema } from "$/assets/contracts";
import { effectValidator } from "$/effect-validator";
import { runHttp } from "$/http/run-effect";
import { PortfolioIdSchema } from "$/portfolios/contracts";
import {
  AssignmentChangeSchema,
  AssignSchema,
  type Subject,
  type WorkflowError,
  WorkflowIdSchema,
  WorkflowSpecSchema,
} from "$/workflows/contracts";
import {
  catalog,
  createWorkflow,
  replaceWorkflow,
} from "$/workflows/operations";
import type { StepRegistry } from "$/workflows/registry";
import { Workflows } from "$/workflows/store";

/** The services workflow routes need. */
export type WorkflowServices = Workflows | StepRegistry;

/** Selects the workflow store and step registry from request bindings. */
export type WorkflowsFor = (
  env: CloudflareBindings,
) => Layer.Layer<WorkflowServices>;

/** The definition a detail, mutation or assignment route acts on. */
const IdParamSchema = Schema.Struct({ id: WorkflowIdSchema });

/** One assignment: the definition and the subject's kind and identifier. */
const AssignmentParamSchema = Schema.Union([
  Schema.Struct({
    id: WorkflowIdSchema,
    kind: Schema.Literal("asset"),
    subjectId: AssetSymbolSchema,
  }),
  Schema.Struct({
    id: WorkflowIdSchema,
    kind: Schema.Literal("portfolio"),
    subjectId: PortfolioIdSchema,
  }),
]);

const subjectOf = (param: typeof AssignmentParamSchema.Type): Subject =>
  param.kind === "asset"
    ? { kind: "asset", symbol: param.subjectId }
    : { kind: "portfolio", id: param.subjectId };

const runner =
  (workflowsFor: WorkflowsFor) =>
  <A>(
    env: CloudflareBindings,
    program: Effect.Effect<A, WorkflowError, WorkflowServices>,
  ) =>
    runHttp(program, workflowsFor(env));

/**
 * Workflow definitions and their assignments. A definition is created and
 * replaced as a whole specification; there are no step-by-step edits.
 * Served by the management API and the app, each with its own auth.
 */
export const createWorkflowRoutes = (
  workflowsFor: WorkflowsFor,
  auth: MiddlewareHandler<{ Bindings: CloudflareBindings }>,
) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", auth);
  const run = runner(workflowsFor);

  app.get("/", async (c) => {
    const workflows = await run(
      c.env,
      Workflows.use((store) => store.list()),
    );
    return c.json({ workflows });
  });

  // 422 with every issue when the steps don't fit the registry.
  app.post(
    "/",
    effectValidator("json", WorkflowSpecSchema, { onExcessProperty: "error" }),
    async (c) => {
      const spec = c.req.valid("json");
      const workflow = await run(
        c.env,
        createWorkflow(spec, crypto.randomUUID(), new Date().toISOString()),
      );
      return c.json(workflow, 201);
    },
  );

  app.get("/:id", effectValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    return c.json(
      await run(
        c.env,
        Workflows.use((store) => store.get(id)),
      ),
    );
  });

  // Replaces the whole specification; an invalid one changes nothing.
  app.put(
    "/:id",
    effectValidator("param", IdParamSchema),
    effectValidator("json", WorkflowSpecSchema, { onExcessProperty: "error" }),
    async (c) => {
      const { id } = c.req.valid("param");
      const spec = c.req.valid("json");
      return c.json(
        await run(c.env, replaceWorkflow(id, spec, new Date().toISOString())),
      );
    },
  );

  app.delete("/:id", effectValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    await run(
      c.env,
      Workflows.use((store) => store.remove(id)),
    );
    return c.body(null, 204);
  });

  app.get(
    "/:id/assignments",
    effectValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const assignments = await run(
        c.env,
        // 404 for an unknown definition rather than an empty list.
        Workflows.use((store) =>
          Effect.andThen(
            store.get(id),
            store.listAssignments({ workflowId: id }),
          ),
        ),
      );
      return c.json({ assignments });
    },
  );

  app.post(
    "/:id/assignments",
    effectValidator("param", IdParamSchema),
    effectValidator("json", AssignSchema, { onExcessProperty: "error" }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { subject, enabled } = c.req.valid("json");
      const assignment = await run(
        c.env,
        Workflows.use((store) =>
          store.assign(id, subject, enabled ?? true, new Date().toISOString()),
        ),
      );
      return c.json(assignment, 201);
    },
  );

  // Enable or disable one subject's assignment.
  app.patch(
    "/:id/assignments/:kind/:subjectId",
    effectValidator("param", AssignmentParamSchema),
    effectValidator("json", AssignmentChangeSchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const param = c.req.valid("param");
      const { enabled } = c.req.valid("json");
      return c.json(
        await run(
          c.env,
          Workflows.use((store) =>
            store.setAssignmentEnabled(
              param.id,
              subjectOf(param),
              enabled,
              new Date().toISOString(),
            ),
          ),
        ),
      );
    },
  );

  app.delete(
    "/:id/assignments/:kind/:subjectId",
    effectValidator("param", AssignmentParamSchema),
    async (c) => {
      const param = c.req.valid("param");
      await run(
        c.env,
        Workflows.use((store) => store.unassign(param.id, subjectOf(param))),
      );
      return c.body(null, 204);
    },
  );

  return app;
};

/** The step catalog: registered step types and their contracts. */
export const createStepTypeRoutes = (
  workflowsFor: WorkflowsFor,
  auth: MiddlewareHandler<{ Bindings: CloudflareBindings }>,
) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", auth);
  const run = runner(workflowsFor);
  app.get("/", async (c) => c.json(await run(c.env, catalog)));
  return app;
};
