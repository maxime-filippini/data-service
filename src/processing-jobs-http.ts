import { Effect, Layer, Result } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

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

export type ProcessingJobBindings = CloudflareBindings & {
  readonly PROCESSING_API_TOKEN?: string;
};

type AppEnvironment = { Bindings: ProcessingJobBindings };
type ControlPlaneLayer = (bindings: ProcessingJobBindings) => Layer.Layer<MarketDataControlPlane>;

const unauthorized = () =>
  new HTTPException(401, {
    res: Response.json({ error: "Unauthorized" }, { status: 401 }),
  });

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

const providedBearerToken = (authorization: string | undefined) => {
  const [scheme, token, ...rest] = authorization?.split(" ") ?? [];
  return scheme === "Bearer" && token !== undefined && rest.length === 0
    ? token
    : undefined;
};

const tokensMatch = async (provided: string, expected: string) => {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
  }

  // Node's Web Crypto implementation used by the lightweight test suite does
  // not expose Cloudflare's timingSafeEqual extension. Both inputs are fixed
  // size SHA-256 digests, so this fallback performs no early exit.
  const actual = new Uint8Array(providedHash);
  const wanted = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual[index]! ^ wanted[index]!;
  }
  return difference === 0;
};

const runProcessingProgram = async <A>(
  program: Effect.Effect<A, MarketDataControlPlaneError, MarketDataControlPlane>,
  controlPlane: Layer.Layer<MarketDataControlPlane>,
) =>
  program.pipe(
    Effect.provide(controlPlane),
    Effect.result,
    Effect.runPromise,
  );

/**
 * Processor-facing API for the frozen job inputs and their state transitions.
 *
 * A caller must possess PROCESSING_API_TOKEN. The API intentionally has no
 * "next job" endpoint: a queue will later deliver a specific job ID, so a
 * processor cannot accidentally take work for another symbol.
 */
export const createProcessingJobsApp = (
  controlPlaneForBindings: ControlPlaneLayer,
) => {
  const app = new Hono<AppEnvironment>();

  app.use("*", async (c, next) => {
    const expected = c.env.PROCESSING_API_TOKEN;
    const provided = providedBearerToken(c.req.header("Authorization"));

    if (
      expected === undefined ||
      provided === undefined ||
      !(await tokensMatch(provided, expected))
    ) {
      throw unauthorized();
    }

    await next();
  });

  const execute = <A>(c: { env: ProcessingJobBindings }, program: Effect.Effect<A, MarketDataControlPlaneError, MarketDataControlPlane>) =>
    runProcessingProgram(program, controlPlaneForBindings(c.env));

  app.post("/", effectValidator("json", CreateProcessingJobSchema), async (c) => {
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
  });

  app.get("/:jobId", async (c) => {
    const result = await execute(c, readSymbolProcessingJob(c.req.param("jobId")));

    if (Result.isFailure(result)) {
      throw controlPlaneException(result.failure);
    }

    return c.json(result.success);
  });

  app.post("/:jobId/claim", async (c) => {
    const jobId = c.req.param("jobId");
    const result = await execute(
      c,
      startSymbolProcessingJob({ jobId, startedAt: new Date().toISOString() }).pipe(
        Effect.andThen(() => readSymbolProcessingJob(jobId)),
      ),
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
