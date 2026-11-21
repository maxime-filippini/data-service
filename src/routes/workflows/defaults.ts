import { Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";

import { effectValidator } from "$/effect-validator";
import { runHttp } from "$/http/run-effect";
import { SubjectKindSchema, WorkflowIdSchema } from "$/workflows/contracts";
import { Workflows } from "$/workflows/store";

import type { WorkflowsFor } from "./index";

const KindParamSchema = Schema.Struct({ kind: SubjectKindSchema });

const DefaultParamSchema = Schema.Struct({
  kind: SubjectKindSchema,
  workflowId: WorkflowIdSchema,
});

const DefaultsQuerySchema = Schema.Struct({
  subjectKind: Schema.optionalKey(SubjectKindSchema),
});

/**
 * Default workflows per subject kind. A default is assigned to each new
 * subject of its kind when the subject is created; adding or removing one
 * never changes existing subjects. Applying the defaults to existing subjects
 * is explicit, adds only missing assignments, and never re-enables a
 * disabled one. Served by the management API and the app, each with its own
 * auth.
 */
export const createWorkflowDefaultRoutes = (
  workflowsFor: WorkflowsFor,
  auth: MiddlewareHandler<{ Bindings: CloudflareBindings }>,
) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", auth);

  app.get(
    "/",
    effectValidator("query", DefaultsQuerySchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const { subjectKind } = c.req.valid("query");
      const defaults = await runHttp(
        Workflows.use((store) => store.listDefaults(subjectKind)),
        workflowsFor(c.env),
      );
      return c.json({ defaults });
    },
  );

  // Registered before `/:kind/:workflowId` so `apply` is not read as an ID.
  app.post(
    "/:kind/apply",
    effectValidator("param", KindParamSchema),
    async (c) => {
      const { kind } = c.req.valid("param");
      const added = await runHttp(
        Workflows.use((store) =>
          store.applyDefaults(kind, new Date().toISOString()),
        ),
        workflowsFor(c.env),
      );
      return c.json({ added });
    },
  );

  // Idempotent: making a default a default again returns it unchanged.
  app.put(
    "/:kind/:workflowId",
    effectValidator("param", DefaultParamSchema),
    async (c) => {
      const { kind, workflowId } = c.req.valid("param");
      return c.json(
        await runHttp(
          Workflows.use((store) =>
            store.addDefault(kind, workflowId, new Date().toISOString()),
          ),
          workflowsFor(c.env),
        ),
      );
    },
  );

  app.delete(
    "/:kind/:workflowId",
    effectValidator("param", DefaultParamSchema),
    async (c) => {
      const { kind, workflowId } = c.req.valid("param");
      await runHttp(
        Workflows.use((store) => store.removeDefault(kind, workflowId)),
        workflowsFor(c.env),
      );
      return c.body(null, 204);
    },
  );

  return app;
};

const AssignmentsQuerySchema = Schema.Struct({
  workflowId: Schema.optionalKey(WorkflowIdSchema),
  subjectKind: Schema.optionalKey(SubjectKindSchema),
  subjectId: Schema.optionalKey(Schema.NonEmptyString),
});

/**
 * Assignments across definitions, each with its definition's daily UTC hour:
 * what is scheduled for which subject. Filter by definition, or by subject
 * (kind and ID together).
 */
export const createAssignmentRoutes = (
  workflowsFor: WorkflowsFor,
  auth: MiddlewareHandler<{ Bindings: CloudflareBindings }>,
) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", auth);

  app.get(
    "/",
    effectValidator("query", AssignmentsQuerySchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const query = c.req.valid("query");
      if ((query.subjectKind === undefined) !== (query.subjectId === undefined))
        return c.json(
          { error: "Give subjectKind and subjectId together" },
          400,
        );
      const subject =
        query.subjectKind === undefined || query.subjectId === undefined
          ? undefined
          : query.subjectKind === "asset"
            ? { kind: "asset" as const, symbol: query.subjectId }
            : { kind: "portfolio" as const, id: query.subjectId };
      const assignments = await runHttp(
        Workflows.use((store) =>
          store.listAssignments({
            ...(query.workflowId === undefined
              ? {}
              : { workflowId: query.workflowId }),
            ...(subject === undefined ? {} : { subject }),
          }),
        ),
        workflowsFor(c.env),
      );
      return c.json({ assignments });
    },
  );

  return app;
};
