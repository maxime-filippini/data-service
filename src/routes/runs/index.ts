import { type Effect, type Layer, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";

import { utcDay } from "$/datetime";
import { effectValidator } from "$/effect-validator";
import { runHttp } from "$/http/run-effect";
import type { RunArtifactStore } from "$/workflows/artifacts";
import { StepIdSchema, type WorkflowError } from "$/workflows/contracts";
import {
  RunIdSchema,
  RunsQuerySchema,
  StartRunSchema,
} from "$/workflows/runs/contracts";
import { RunCoordinator } from "$/workflows/runs/coordinator";
import { getRunArtifact } from "$/workflows/runs/operations";
import { WorkflowRunStore } from "$/workflows/runs/store";

/** The services run routes need. */
export type RunServices = WorkflowRunStore | RunArtifactStore | RunCoordinator;

/** Selects the run routes' services from request bindings. */
export type RunServicesFor = (
  env: CloudflareBindings,
) => Layer.Layer<RunServices>;

/** Most runs a list returns when no limit is given. */
const DEFAULT_RUN_LIST = 50;

const RunParamSchema = Schema.Struct({ runId: RunIdSchema });

const ArtifactParamSchema = Schema.Struct({
  runId: RunIdSchema,
  stepId: StepIdSchema,
  output: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*$/u)),
});

/**
 * Workflow runs: start an assignment manually, list runs, read a run's step
 * outcomes and artifacts, and rerun from the beginning. Starting returns the
 * run straight away (202); the run executes in its own Workflow instance.
 * Served by the management API and the app, each with its own auth.
 */
export const createRunRoutes = (
  servicesFor: RunServicesFor,
  auth: MiddlewareHandler<{ Bindings: CloudflareBindings }>,
) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", auth);

  const run = <A>(
    env: CloudflareBindings,
    program: Effect.Effect<A, WorkflowError, RunServices>,
  ) => runHttp(program, servicesFor(env));

  // The processing date defaults to today's UTC date. A `skipped` run means
  // another run of the assignment was still active.
  app.post(
    "/",
    effectValidator("json", StartRunSchema, { onExcessProperty: "error" }),
    async (c) => {
      const input = c.req.valid("json");
      const started = await run(
        c.env,
        RunCoordinator.use((runs) =>
          runs.start({
            workflowId: input.workflowId,
            subject: input.subject,
            processingDate: input.processingDate ?? utcDay(new Date()),
            trigger: "manual",
          }),
        ),
      );
      return c.json(started, 202);
    },
  );

  app.get(
    "/",
    effectValidator("query", RunsQuerySchema, { onExcessProperty: "error" }),
    async (c) => {
      const query = c.req.valid("query");
      const runs = await run(
        c.env,
        WorkflowRunStore.use((store) =>
          store.list({
            ...(query.workflowId === undefined
              ? {}
              : { workflowId: query.workflowId }),
            ...(query.subjectKind === undefined
              ? {}
              : {
                  subject: {
                    kind: query.subjectKind,
                    ...(query.subjectId === undefined
                      ? {}
                      : { id: query.subjectId }),
                  },
                }),
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.trigger === undefined ? {} : { trigger: query.trigger }),
            limit:
              query.limit === undefined
                ? DEFAULT_RUN_LIST
                : Number(query.limit),
          }),
        ),
      );
      return c.json({ runs });
    },
  );

  app.get("/:runId", effectValidator("param", RunParamSchema), async (c) => {
    const { runId } = c.req.valid("param");
    return c.json(
      await run(
        c.env,
        WorkflowRunStore.use((store) => store.get(runId)),
      ),
    );
  });

  // A new run of the same assignment and processing date, from the beginning.
  app.post(
    "/:runId/rerun",
    effectValidator("param", RunParamSchema),
    async (c) => {
      const { runId } = c.req.valid("param");
      const started = await run(
        c.env,
        RunCoordinator.use((runs) => runs.rerun(runId)),
      );
      return c.json(started, 202);
    },
  );

  // The contents of an artifact a step output references.
  app.get(
    "/:runId/steps/:stepId/artifacts/:output",
    effectValidator("param", ArtifactParamSchema),
    async (c) => {
      const { runId, stepId, output } = c.req.valid("param");
      const { reference, content } = await run(
        c.env,
        getRunArtifact(runId, stepId, output),
      );
      return new Response(content.body, {
        headers: {
          "Content-Type": content.contentType,
          "X-Artifact-Schema": reference.schema,
          "Cache-Control": "no-store",
        },
      });
    },
  );

  return app;
};
