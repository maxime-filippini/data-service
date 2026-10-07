import { Effect, Layer, Result } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  processingToken,
  type ProcessingTokenBindings,
} from "$/auth/processing-token";
import { effectValidator } from "$/effect-validator";
import {
  MarketDataControlPlane,
  MarketDataControlPlaneError,
} from "$/market-data/control-plane";
import {
  completeSymbolProcessingJob,
  failSymbolProcessingJob,
  prepareSymbolProcessingJob,
  readSymbolProcessingJob,
  startSymbolProcessingJob,
} from "$/market-data/processing";
import {
  CompleteProcessingJobSchema,
  CreateProcessingJobSchema,
  FailProcessingJobSchema,
} from "$/market-data/schemas";
import { requireBearerToken } from "$/middleware/require-bearer-token";

export type ProcessingJobBindings = CloudflareBindings &
  ProcessingTokenBindings;

type AppEnvironment = { Bindings: ProcessingJobBindings };

type ControlPlaneLayer = (
  bindings: ProcessingJobBindings,
) => Layer.Layer<MarketDataControlPlane>;

const controlPlaneException = (error: MarketDataControlPlaneError) => {
  const status =
    error.kind === "not_found"
      ? 404
      : error.kind === "conflict" || error.kind === "no_work"
        ? 409
        : 500;

  return new HTTPException(status, {
    res: Response.json(
      {
        error: error.message,
        jobId: error.jobId ?? null,
        symbol: error.symbol ?? null,
      },
      { status },
    ),
  });
};

const runProcessingProgram = async <A>(
  program: Effect.Effect<
    A,
    MarketDataControlPlaneError,
    MarketDataControlPlane
  >,
  controlPlane: Layer.Layer<MarketDataControlPlane>,
) =>
  program.pipe(Effect.provide(controlPlane), Effect.result, Effect.runPromise);

/**
 * Processor-facing API for the frozen job inputs and their state transitions.
 *
 * A caller must possess PROCESSING_API_TOKEN. The API intentionally has no
 * "next job" endpoint: the scheduled queue delivers a specific job ID, so a
 * processor cannot accidentally take work for another symbol.
 */
export const createProcessingRoutes = (
  controlPlaneForBindings: ControlPlaneLayer,
) => {
  const app = new Hono<AppEnvironment>();

  // Auth middleware for all sub-routes
  app.use("*", requireBearerToken<AppEnvironment>(processingToken));

  // Execute a given Effect based on the control plane
  const execute = <A>(
    c: { env: ProcessingJobBindings },
    program: Effect.Effect<
      A,
      MarketDataControlPlaneError,
      MarketDataControlPlane
    >,
  ) => runProcessingProgram(program, controlPlaneForBindings(c.env));

  app.post(
    "/",
    effectValidator("json", CreateProcessingJobSchema),
    async (c) => {
      const request = c.req.valid("json");
      const result = await execute(
        c,
        prepareSymbolProcessingJob({
          ...request,
          jobId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        }),
      );

      if (Result.isFailure(result)) {
        throw controlPlaneException(result.failure);
      }

      return c.json(result.success, 201);
    },
  );

  app.get("/:jobId", async (c) => {
    const result = await execute(
      c,
      readSymbolProcessingJob(c.req.param("jobId")),
    );

    if (Result.isFailure(result)) {
      throw controlPlaneException(result.failure);
    }

    return c.json(result.success);
  });

  app.post("/:jobId/claim", async (c) => {
    const jobId = c.req.param("jobId");
    const result = await execute(
      c,
      startSymbolProcessingJob({
        jobId,
        startedAt: new Date().toISOString(),
      }).pipe(Effect.andThen(() => readSymbolProcessingJob(jobId))),
    );

    if (Result.isFailure(result)) {
      throw controlPlaneException(result.failure);
    }

    return c.json(result.success);
  });

  app.post(
    "/:jobId/complete",
    effectValidator("json", CompleteProcessingJobSchema),
    async (c) => {
      const jobId = c.req.param("jobId");
      const request = c.req.valid("json");
      const result = await execute(
        c,
        completeSymbolProcessingJob({
          ...request,
          jobId,
          completedAt: new Date().toISOString(),
        }).pipe(Effect.andThen(() => readSymbolProcessingJob(jobId))),
      );

      if (Result.isFailure(result)) {
        throw controlPlaneException(result.failure);
      }

      return c.json(result.success);
    },
  );

  app.post(
    "/:jobId/fail",
    effectValidator("json", FailProcessingJobSchema),
    async (c) => {
      const jobId = c.req.param("jobId");
      const { message } = c.req.valid("json");
      const result = await execute(
        c,
        failSymbolProcessingJob({
          jobId,
          message,
          completedAt: new Date().toISOString(),
        }).pipe(Effect.andThen(() => readSymbolProcessingJob(jobId))),
      );

      if (Result.isFailure(result)) {
        throw controlPlaneException(result.failure);
      }

      return c.json(result.success);
    },
  );

  return app;
};
