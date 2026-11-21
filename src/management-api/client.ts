/**
 * A client for one management API instance, for code that drives the API the
 * way an operator would: through its routes, with its bearer token. Scripts
 * use the HTTP client; tests can supply their own `ManagementApi`.
 */

import { Context, Effect, Layer, Schema } from "effect";

/**
 * A failed request: the instance was unreachable (`status` null) or answered
 * with a non-2xx status. The message names the request and the response body.
 */
export class ManagementApiError extends Schema.TaggedError<ManagementApiError>()(
  "ManagementApiError",
  {
    status: Schema.NullOr(Schema.Number),
    message: Schema.String,
  },
) {}

/** Sends JSON requests to one instance's `/api` routes. */
export class ManagementApi extends Context.Service<
  ManagementApi,
  {
    /** Send `body` (if any) as JSON and decode the JSON response, if any. */
    readonly request: <T = unknown>(
      method: string,
      route: string,
      body?: unknown,
    ) => Effect.Effect<T, ManagementApiError>;
  }
>()("data-service/ManagementApi") {}

/** Where an instance is and how to reach it. */
export interface ManagementApiOptions {
  /** The instance's origin, such as `https://data-service.example.com`. */
  readonly origin: string;
  readonly token: string;
  /**
   * Sends a request: `fetch` for a deployed Worker, or the routes' own
   * `fetch` with local bindings for an in-process instance.
   */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Told `METHOD /api/route -> status` after each response, such as for a log. */
  readonly onResponse?: (line: string) => Effect.Effect<void>;
}

/** The client over HTTP, authenticated with the instance's management token. */
export const HttpManagementApiLive = (
  options: ManagementApiOptions,
): Layer.Layer<ManagementApi> =>
  Layer.succeed(ManagementApi, {
    request: <T>(method: string, route: string, body?: unknown) =>
      Effect.gen(function* () {
        const name = `${method} /api${route}`;
        const response = yield* Effect.tryPromise({
          try: () =>
            options.fetch(
              new Request(`${options.origin}/api${route}`, {
                method,
                headers: {
                  Authorization: `Bearer ${options.token}`,
                  ...(body === undefined
                    ? {}
                    : { "Content-Type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
            ),
          catch: (error) =>
            new ManagementApiError({
              status: null,
              message: `${name} failed: ${String(error)}`,
            }),
        });
        const text = yield* Effect.promise(() => response.text());
        if (options.onResponse !== undefined)
          yield* options.onResponse(`${name} -> ${response.status}`);
        if (!response.ok)
          return yield* Effect.fail(
            new ManagementApiError({
              status: response.status,
              message: `${name} -> ${response.status}: ${text}`,
            }),
          );
        return (text === "" ? undefined : JSON.parse(text)) as T;
      }),
  });
