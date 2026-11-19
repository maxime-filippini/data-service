import { Context, Effect, Layer, Result, Schema, SchemaIssue } from "effect";

import {
  type OperationName,
  OperationErrorResponse,
  operations,
} from "./contracts.generated";

/** Widen each generated schema while keeping the types tied to its operation name. */
const operationContracts: {
  readonly [N in OperationName]: {
    readonly request: Schema.Codec<OperationRequest<N>, unknown>;
    readonly response: Schema.Codec<OperationResponse<N>, unknown>;
  };
} = operations;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Calls to the Python service's uniform operations (`POST /operations/{name}`).
 * Requests and responses are validated at runtime against the contracts
 * generated from the Python service's Pydantic models, on top of the
 * compile-time types. In the Worker the service is the engine container;
 * locally it is the same Python app run with uv on localhost.
 */

/** An operation's request, response and name types. */
type Operations = typeof operations;
export type OperationRequest<N extends OperationName> =
  Operations[N]["request"]["Type"];
export type OperationResponse<N extends OperationName> =
  Operations[N]["response"]["Type"];

/**
 * A failed call. `transient` (unreachable service, storage trouble, an
 * unexpected Python error) may succeed when retried; `terminal` (invalid
 * request, deterministic domain error, a response that breaks its contract)
 * will not.
 */
export class OperationError extends Schema.TaggedError<OperationError>()(
  "OperationError",
  {
    kind: Schema.Literals(["transient", "terminal"]),
    message: Schema.String,
  },
) {}

/** Injectable Python operations: HTTP to the engine, or a local process. */
export class PythonOperations extends Context.Service<
  PythonOperations,
  {
    readonly invoke: <N extends OperationName>(
      name: N,
      request: OperationRequest<N>,
    ) => Effect.Effect<OperationResponse<N>, OperationError>;
  }
>()("data-service/PythonOperations") {}

/** What the client sends requests through: a container stub or `fetch`. */
export interface OperationsFetcher {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const validate = <A>(
  schema: Schema.Codec<A, unknown>,
  value: unknown,
): Result.Result<A, string> => {
  const result = Schema.decodeUnknownResult(schema, {
    errors: "all",
    onExcessProperty: "error",
  })(value);
  if (Result.isSuccess(result)) return Result.succeed(result.success);
  return Result.fail(
    formatIssue(result.failure.issue)
      .issues.map((issue) =>
        issue.path === undefined || issue.path.length === 0
          ? issue.message
          : `${issue.path.map(String).join(".")}: ${issue.message}`,
      )
      .join("; "),
  );
};

const transient = (message: string) =>
  new OperationError({ kind: "transient", message });
const terminal = (message: string) =>
  new OperationError({ kind: "terminal", message });

/**
 * Explain a non-2xx response. The Python service always sends the error
 * contract; anything else (a proxy or container error page) is classified
 * by status: 5xx and 429 may be transient, other 4xx are terminal.
 */
const failureOf = (name: string, status: number, body: unknown) => {
  const parsed = validate(OperationErrorResponse, body);
  if (Result.isSuccess(parsed)) {
    const { kind, message, issues = [] } = parsed.success.error;
    const details = issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return new OperationError({
      kind,
      message: details.length > 0 ? `${message}: ${details}` : message,
    });
  }
  const message = `Operation ${name} returned HTTP ${status}`;
  return status >= 500 || status === 429
    ? transient(message)
    : terminal(message);
};

/**
 * The HTTP client. `baseUrl` is `http://engine` for the container binding,
 * or `http://127.0.0.1:<port>` for a local service.
 */
export const HttpPythonOperationsLive = (
  fetcher: OperationsFetcher,
  baseUrl: string,
): Layer.Layer<PythonOperations> =>
  Layer.succeed(
    PythonOperations,
    PythonOperations.of({
      invoke: (name, request) =>
        Effect.gen(function* () {
          const operation = operationContracts[name];
          const valid = validate(operation.request, request);
          if (Result.isFailure(valid))
            return yield* terminal(
              `The ${name} request does not satisfy its contract: ${valid.failure}`,
            );
          const response = yield* Effect.tryPromise({
            try: () =>
              fetcher.fetch(`${baseUrl}/operations/${name}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(valid.success),
              }),
            catch: (cause) =>
              transient(
                `The Python service could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
          });
          const body = yield* Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: () => undefined,
          }).pipe(Effect.option);
          if (!response.ok)
            return yield* failureOf(
              name,
              response.status,
              body._tag === "Some" ? body.value : undefined,
            );
          // A body cut off in transit says nothing about the work itself.
          if (body._tag === "None")
            return yield* transient(`The ${name} response could not be read`);
          const output = validate(operation.response, body.value);
          if (Result.isFailure(output))
            return yield* terminal(
              `The ${name} response does not satisfy its contract: ${output.failure}`,
            );
          return output.success;
        }),
    }),
  );
