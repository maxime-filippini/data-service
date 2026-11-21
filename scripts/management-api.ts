/**
 * A client for one management API instance, for scripts that drive the API
 * the way an operator would: through its routes, with its bearer token.
 */

import { Context, Effect, Layer } from "effect";

import { ScriptError } from "./cli";

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

/**
 * Sends JSON requests to the instance's `/api` routes. A transport failure
 * or a non-2xx response fails with a `ScriptError` naming the request.
 */
export class ManagementApi extends Context.Service<
  ManagementApi,
  {
    /** Send `body` (if any) as JSON and decode the JSON response, if any. */
    readonly request: <T = unknown>(
      method: string,
      route: string,
      body?: unknown,
    ) => Effect.Effect<T, ScriptError>;
  }
>()("scripts/ManagementApi") {}

export const ManagementApiLive = (
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
          catch: (error) => new ScriptError(`${name} failed: ${String(error)}`),
        });
        const text = yield* Effect.promise(() => response.text());
        if (options.onResponse !== undefined)
          yield* options.onResponse(`${name} -> ${response.status}`);
        if (!response.ok)
          return yield* Effect.fail(
            new ScriptError(`${name} -> ${response.status}: ${text}`),
          );
        return (text === "" ? undefined : JSON.parse(text)) as T;
      }),
  });
