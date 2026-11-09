import { Effect, type Layer, Result } from "effect";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { CalculationError } from "$/calculations/contracts";
import type { EngineError } from "$/calculations/engine";
import type { ScheduleError } from "$/market-data/schedule/contracts";
import type { PipelineStatusError } from "$/market-data/status";
import type { SymbolRegistryError } from "$/market-data/symbol-registry";
import type { PortfolioError } from "$/portfolios/contracts";

/** Expected failures exposed by the Worker's JSON routes. */
type RequestError =
  | CalculationError
  | EngineError
  | PortfolioError
  | ScheduleError
  | PipelineStatusError
  | SymbolRegistryError;

const calculationStatus = {
  not_found: 404,
  invalid: 422,
  workflow: 500,
  database: 500,
} as const satisfies Record<CalculationError["kind"], ContentfulStatusCode>;

const engineStatus = {
  not_found: 404,
  invalid: 422,
  failed: 500,
  unavailable: 503,
  timeout: 504,
} as const satisfies Record<EngineError["kind"], ContentfulStatusCode>;

const portfolioStatus = {
  not_found: 404,
  conflict: 409,
  untracked_symbols: 400,
  no_holdings: 422,
  database: 500,
} as const satisfies Record<PortfolioError["kind"], ContentfulStatusCode>;

/** Translate expected failures here so routes share status and metadata rules. */
const httpException = (error: RequestError): HTTPException => {
  let status: ContentfulStatusCode;
  let extra: Record<string, unknown> = {};
  switch (error._tag) {
    case "CalculationError":
      status = calculationStatus[error.kind];
      if (error.portfolioIds !== undefined)
        extra = { portfolioIds: error.portfolioIds };
      break;
    case "EngineError":
      status = engineStatus[error.kind];
      if (error.detail !== undefined) extra = { detail: error.detail };
      break;
    case "PortfolioError":
      status = portfolioStatus[error.kind];
      extra = {
        ...(error.symbols === undefined ? {} : { symbols: error.symbols }),
        ...(error.calculations === undefined
          ? {}
          : { calculations: error.calculations }),
      };
      break;
    case "SymbolRegistryError":
      status = error.kind === "not_found" ? 404 : 500;
      break;
    case "ScheduleError":
    case "PipelineStatusError":
      status = 500;
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
