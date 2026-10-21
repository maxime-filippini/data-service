import { Context, Effect, Layer, Schema } from "effect";

import type { CalculationParams, CalculationTypeInfo, PortfolioOutcome } from "$/calculations/views";
import type { EnginePortfolio, Holding } from "$/portfolios";

/** How long an ad hoc calculation may take, including a cold start. */
export const CALCULATE_TIMEOUT_MS = 60_000;

/** How long listing types or validating params may take, including a cold start. */
const QUICK_TIMEOUT_MS = 30_000;

export const ARROW_STREAM = "application/vnd.apache.arrow.stream";

export type { CalculationParams, CalculationTypeInfo, PortfolioOutcome } from "$/calculations/views";

/** One run of a saved calculation for one as-of date. */
export interface RunRequest {
  readonly runId: string;
  readonly type: string;
  readonly params: CalculationParams;
  readonly asOf: string;
  readonly portfolios: readonly EnginePortfolio[];
  /** Where the rows go in the processed bucket, e.g. `calculation=<id>/data.parquet`. */
  readonly outputKey: string;
}

/** What happened in a run. `partial`: some portfolios failed, the others were written. */
export interface RunResult {
  readonly status: "completed" | "partial" | "failed";
  readonly error: string | null;
  readonly portfolios: readonly PortfolioOutcome[];
  readonly rowCount: number;
  readonly outputEtag: string | null;
}

/** An ad hoc portfolio: saved snapshots, or plain holdings held at all times. */
export type AdHocPortfolio = EnginePortfolio | { readonly holdings: readonly Holding[] };

/** An ad hoc calculation. Nothing is saved. */
export interface CalculateRequest {
  readonly type: string;
  readonly params: CalculationParams;
  readonly asOf: string;
  /** Left out for types that don't take a portfolio. */
  readonly portfolio?: AdHocPortfolio;
}

export class EngineError extends Schema.TaggedError<EngineError>()("EngineError", {
  /**
   * `not_found`: unknown type. `invalid`: invalid params or request (the
   * engine's 422). `failed`: the calculation or the engine failed.
   * `unavailable`: the container could not be reached. `timeout`: it took too long.
   */
  kind: Schema.Literals(["not_found", "invalid", "failed", "unavailable", "timeout"]),
  message: Schema.String,
  /** The engine's `detail`, such as the list of params errors for `invalid`. */
  detail: Schema.optionalKey(Schema.Unknown),
}) {}

/**
 * The calculation engine container. It knows every calculation type; the
 * Worker treats params as plain JSON and asks the engine to check them.
 */
export class Engine extends Context.Service<
  Engine,
  {
    readonly listTypes: () => Effect.Effect<readonly CalculationTypeInfo[], EngineError>;
    /** The params with defaults filled in. */
    readonly validate: (type: string, params: CalculationParams) => Effect.Effect<CalculationParams, EngineError>;
    /** Runs a saved calculation and writes its rows to R2. Doesn't time out. */
    readonly run: (request: RunRequest) => Effect.Effect<RunResult, EngineError>;
    /**
     * Runs an ad hoc calculation. On success, the engine's response as is:
     * JSON `{ rows }`, or an Arrow IPC stream when `accept` asks for one.
     */
    readonly calculate: (request: CalculateRequest, accept?: string) => Effect.Effect<Response, EngineError>;
  }
>()("data-service/Engine") {}

const kindOf = (status: number): EngineError["kind"] =>
  status === 404 ? "not_found" : status === 422 ? "invalid" : "failed";

/** The engine's error response (FastAPI's `{ detail }`) as an EngineError. */
const errorFrom = async (response: Response) => {
  const text = await response.text().catch(() => "");
  let detail: unknown = text;
  try {
    detail = (JSON.parse(text) as { detail?: unknown }).detail ?? text;
  } catch {
    // Not JSON; keep the raw text.
  }
  const kind = kindOf(response.status);
  const message =
    typeof detail === "string" && detail.length > 0
      ? detail.slice(0, 500)
      : kind === "invalid"
        ? "Invalid request"
        : `Engine returned ${response.status}`;
  return new EngineError({ kind, message, ...(typeof detail === "string" ? {} : { detail }) });
};

/** An engine client over the container's Durable Object stub. */
export const EngineLive = (engine: Pick<Fetcher, "fetch">): Layer.Layer<Engine> => {
  /** Calls the engine. Non-2xx responses fail with the engine's error. */
  const call = (path: string, init: RequestInit, timeoutMs?: number) => {
    const request = Effect.tryPromise({
      try: (signal) => engine.fetch(`http://engine${path}`, { ...init, signal }),
      catch: () => new EngineError({ kind: "unavailable", message: "The calculation engine could not be reached" }),
    });
    const timed =
      timeoutMs === undefined
        ? request
        : request.pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () =>
                Effect.fail(
                  new EngineError({ kind: "timeout", message: `The calculation engine took over ${timeoutMs / 1000}s` }),
                ),
            }),
          );
    return timed.pipe(
      Effect.flatMap((response) =>
        response.ok ? Effect.succeed(response) : Effect.promise(() => errorFrom(response)).pipe(Effect.flatMap(Effect.fail)),
      ),
    );
  };

  const json = <A>(response: Response) =>
    Effect.tryPromise({
      try: () => response.json() as Promise<A>,
      catch: () => new EngineError({ kind: "failed", message: "The calculation engine sent invalid JSON" }),
    });

  const post = (body: unknown, accept = "application/json"): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept },
    body: JSON.stringify(body),
  });

  return Layer.succeed(
    Engine,
    Engine.of({
      listTypes: () =>
        call("/types", { headers: { Accept: "application/json" } }, QUICK_TIMEOUT_MS).pipe(
          Effect.flatMap(json<readonly CalculationTypeInfo[]>),
        ),

      validate: (type, params) =>
        call(`/types/${encodeURIComponent(type)}/validate`, post({ params }), QUICK_TIMEOUT_MS).pipe(
          Effect.flatMap(json<{ params: CalculationParams }>),
          Effect.map((body) => body.params),
        ),

      run: (request) => call("/runs", post(request)).pipe(Effect.flatMap(json<RunResult>)),

      calculate: (request, accept) =>
        call("/calculate", post(request, accept ?? "application/json"), CALCULATE_TIMEOUT_MS),
    }),
  );
};
