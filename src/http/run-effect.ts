import { Effect, type Layer, Result } from "effect";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AssetError } from "$/assets/contracts";
import type { DatasetError } from "$/datasets/contracts";
import type { PortfolioError } from "$/portfolios/contracts";
import type { WorkflowError } from "$/workflows/contracts";

const portfolioStatus = {
  not_found: 404,
  conflict: 409,
  untracked_symbols: 400,
  no_holdings: 422,
  database: 500,
} as const satisfies Record<PortfolioError["kind"], ContentfulStatusCode>;

const assetStatus = {
  not_found: 404,
  conflict: 409,
  database: 500,
} as const satisfies Record<AssetError["kind"], ContentfulStatusCode>;

const workflowStatus = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
  database: 500,
} as const satisfies Record<WorkflowError["kind"], ContentfulStatusCode>;

const datasetStatus = {
  not_found: 404,
  database: 500,
  storage: 503,
} as const satisfies Record<DatasetError["kind"], ContentfulStatusCode>;

/** Expected failures exposed by the Worker's JSON routes. */
type RequestError = AssetError | DatasetError | WorkflowError | PortfolioError;

/** Translate expected failures here so routes share status and metadata rules. */
const httpException = (error: RequestError): HTTPException => {
  let status: ContentfulStatusCode;
  let extra: Record<string, unknown> = {};
  switch (error._tag) {
    case "AssetError":
      status = assetStatus[error.kind];
      break;
    case "DatasetError":
      status = datasetStatus[error.kind];
      break;
    case "WorkflowError":
      status = workflowStatus[error.kind];
      if (error.issues !== undefined) extra = { issues: error.issues };
      break;
    case "PortfolioError":
      status = portfolioStatus[error.kind];
      extra = {
        ...(error.symbols === undefined ? {} : { symbols: error.symbols }),
      };
      break;
  }
  return new HTTPException(status, {
    res: Response.json({ error: error.message, ...extra }, { status }),
  });
};

/**
 * Execute at the HTTP edge: supply dependencies and translate expected failures.
 * Defects still reject the promise and reach Hono's unexpected-error handler.
 * Business operations return Effects and never call this helper themselves.
 */
export const runHttp = async <A, E extends RequestError, R>(
  program: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R>,
): Promise<A> => {
  const result = await program.pipe(
    Effect.provide(layer),
    Effect.result,
    Effect.runPromise,
  );
  if (Result.isFailure(result)) throw httpException(result.failure);
  return result.success;
};
