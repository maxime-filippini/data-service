# Effect v4 HTTP application composition

## Conclusion

The current Hono endpoint contains more application assembly than it needs to,
but turning both the decoded query and the Worker bindings into ordinary Effect
services would not be the idiomatic fix.

- Keep the decoded market-data query as an explicit argument to a reusable
  application function.
- Treat the EODHD token as configuration used to construct the `MarketData`
  implementation.
- Define the application function and provider wiring outside the route body.
  Leave the Hono handler responsible only for adapting Hono inputs, running the
  prepared Effect, and translating the result to an HTTP response.

This is the same separation used by Effect's first-party HTTP example: API
contracts are separate from server implementations; handler layers are defined
at module scope; request `query`, `payload`, and `params` values arrive as
handler arguments; application services are acquired from Effect context; and
the complete route/server layers are composed at the application boundary.
[Official Effect `HttpApi` walkthrough](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/51_http-server/10_basics.ts)
[Official users handler fixture](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/51_http-server/fixtures/server/Users/http.ts)

## What the official application does

Effect's v4 `HttpApi` walkthrough separates three concerns:

1. The API value describes endpoint paths and request/response schemas. The
   walkthrough explicitly says API definitions should be separate from server
   implementations so they can be shared with clients.
2. `HttpApiBuilder.group` defines the endpoint implementations as a `Layer`.
   The users implementation acquires its `Users` service once in the group
   construction effect, then registers handlers such as
   `list: ({ query }) => users.list(query.search)`.
3. The entrypoint constructs `ApiRoutes`, supplies all handler layers, merges
   documentation routes, supplies the platform server, and finally exposes a
   Web handler or launches the server.

The relevant first-party files are the
[`HttpApi` walkthrough](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/51_http-server/10_basics.ts)
and its
[`Users` handler implementation](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/51_http-server/fixtures/server/Users/http.ts).
The API reference describes the same model: `HttpApiBuilder.group` creates a
layer implementing an API group, while the resulting handlers preserve their
service requirements for the layer graph to satisfy.
[Effect v4 `HttpApiBuilder` reference](https://effect.website/docs/v4/api/effect/http-api/HttpApiBuilder)

The users fixture also exports two compositions deliberately:
`UsersApiHandlersNoDeps`, whose `Users` service remains injectable for tests,
and `UsersApiHandlers`, which supplies the production `Users.layer` and
authorization layer. This is a close analogue of keeping a provider-neutral
market-data program separate from `EodhdLive`.
[Official users handler fixture](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/51_http-server/fixtures/server/Users/http.ts)

## Should the query be an Effect dependency?

Usually no. The query is input to one operation, so it should remain an
argument:

```ts
export const retrieveMarketData = Effect.fn("retrieveMarketData")(
  function* (query: MarketDataRequest) {
    const marketData = yield* MarketData
    return yield* marketData.retrieveDaily(query)
  },
)
```

This gives the program the useful type-level distinction:

- `query` is data supplied to this invocation;
- `MarketData` is a capability the program requires.

The official `HttpApi` handler API makes the same distinction. It decodes the
endpoint's schemas, then passes request values to a handler in an object such as
`{ query }`, `{ payload }`, or `{ params }`; the handler's Effect context is
reserved for capabilities such as the `Users` service or middleware-provided
`CurrentUser`.
[Official users handler fixture](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/51_http-server/fixtures/server/Users/http.ts)
[Effect v4 `HttpApiEndpoint` reference](https://effect.website/docs/v4/api/effect/http-api/HttpApiEndpoint)

At the lower-level HTTP API, the complete current request *is* available as an
`HttpServerRequest` context service. That is platform plumbing used by routers,
middleware, and body/query decoders; it does not imply that every decoded
business input should be promoted to its own service.
[Effect v4 `HttpServerRequest` reference](https://effect.website/docs/v4/api/effect/http/HttpServerRequest)

Making `MarketDataRequest` a context service would hide a normal function input,
require building/providing a new context value for each call, and make direct
unit tests less obvious. A request-scoped service is more appropriate for a
cross-cutting capability used by many nested operations, such as an authenticated
principal or request correlation metadata.

## Should the Worker environment be an Effect dependency?

The raw `env` object is a platform boundary value. The EODHD token inside it is
application configuration, so it is reasonable to bridge that value into
Effect at the boundary rather than pass it deep into application code.

Effect v4's configuration model separates a `Config` description from the
`ConfigProvider` that supplies raw values. The official documentation explicitly
calls `ConfigProvider.fromEnv({ env })` useful for tests and non-Node runtimes,
and recommends `Config.Redacted` for secrets.
[Effect v4 configuration guide](https://effect.website/docs/v4/configuration)

That suggests this shape:

```ts
// eodhd.ts
const EodhdApiToken = Config.Redacted("EODHD_API_TOKEN")

// EodhdLive is a stable Layer value whose construction reads EodhdApiToken.
export const EodhdLive: Layer.Layer<MarketData, MarketDataError> = /* ... */

// market-data-program.ts
export const retrieveMarketData = Effect.fn("retrieveMarketData")(
  function* (query: MarketDataRequest) {
    const marketData = yield* MarketData
    return yield* marketData.retrieveDaily(query)
  },
)
```

The Worker/Hono boundary can then install a provider made from `c.env` while it
runs the already-defined program. If keeping the current explicit
`EodhdLive(token)` constructor is preferred, the same architectural separation
still works: create a small runner function outside the route body that accepts
the environment and query, supplies the layer, and runs `retrieveMarketData`.
Using `Config` is useful here because it centralizes missing/empty secret parsing
and protects accidental logging; it is not required merely to make the code
"more Effect-like."

Cloudflare supplies module Worker bindings at request dispatch, so some bridge
from `c.env` must remain at or near the fetch/route boundary. What should move
out of the route body is the definition of the business program and the layer
graph, not the unavoidable act of receiving that platform value.

## Comparison with the current Hono handler

The current route performs all of these steps inline:

1. reads `c.env.EODHD_API_TOKEN`;
2. constructs `EodhdLive`;
3. defines the market-data Effect program;
4. supplies the layer;
5. runs the Effect;
6. maps domain failures to Hono responses.

Steps 3 and the stable parts of steps 2/4 belong outside the callback. Steps 1,
5, and 6 are legitimate adapter responsibilities because Hono owns the concrete
request, environment, and response types.

A pragmatic Hono structure would therefore be:

```ts
// Defined once at module scope.
const retrieveMarketData = Effect.fn("retrieveMarketData")(
  function* (query: MarketDataRequest) {
    const marketData = yield* MarketData
    return yield* marketData.retrieveDaily(query)
  },
)

const runMarketData = (query: MarketDataRequest, apiToken: unknown) =>
  retrieveMarketData(query).pipe(
    Effect.provide(EodhdLive(apiToken)),
    Effect.result,
    Effect.runPromise,
  )

app.get(
  "/market-data",
  effectValidator("query", MarketDataQuerySchema),
  async (c) => {
    const result = await runMarketData(
      c.req.valid("query"),
      c.env.EODHD_API_TOKEN,
    )
    // Hono-specific Result -> response translation only.
  },
)
```

This is an incremental cleanup, not the most Effect-native HTTP architecture.
The full Effect-native alternative is to replace Hono routing with `HttpApi`:
declare the query schema on `HttpApiEndpoint`, implement the handler with
`HttpApiBuilder.group`, provide `EodhdLive` in the route layer graph, and expose
one Web handler. Effect then owns request decoding, typed errors, success
encoding, and OpenAPI metadata. `HttpApiBuilder` is currently marked unstable
in the v4 API, so that migration has a larger adoption cost than simply
cleaning up the Hono adapter.
[Effect v4 `HttpApi` reference](https://effect.website/docs/v4/api/effect/http-api/HttpApi)
[Effect v4 `HttpApiBuilder` reference](https://effect.website/docs/v4/api/effect/http-api/HttpApiBuilder)

Effect's Web handler helpers also support constructing a handler from an Effect
and a layer, and document that the layer is built when the handler is created,
not anew for every request. This supports keeping stable application wiring out
of endpoint callbacks when the host runtime makes the required configuration
available at handler construction time.
[Effect v4 `HttpEffect.toWebHandlerLayer` reference](https://effect.website/docs/v4/api/effect/http/HttpEffect#toWebHandlerLayer)

## Recommendation for this repository

Keep Hono for now and make a focused refactor:

1. Extract `retrieveMarketData(query)` as a module-level application Effect
   requiring `MarketData`.
2. Extract one runner/composition function that bridges Worker configuration,
   provides `EodhdLive`, and executes the program.
3. Keep the validated query as an explicit function argument.
4. Prefer `Config.Redacted("EODHD_API_TOKEN")` plus a provider made from the
   Worker bindings if more configuration is likely to appear. With only one
   token, an explicit layer constructor remains reasonable.
5. Keep Hono-specific status and response conversion in the route adapter.

If the project later grows several endpoint groups, typed error responses, or a
generated client, migrate the HTTP boundary to Effect `HttpApi`. The first-party
example then becomes a direct template rather than just an architectural guide.
