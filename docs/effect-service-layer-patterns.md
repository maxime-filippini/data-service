# Effect v4 service and layer patterns for the EODHD adapter

## Conclusion

`makeRetrieveSymbol(client, token)` returning a function that returns an
`Effect` is valid Effect code, but the extra factory is not required by Effect
and adds indirection here.

The important seam is the public market-data interface:

- `MarketData.retrieveDaily` should be a function returning an `Effect`.
- The returned effect should not expose `HttpClient` as a requirement, because
  the client is an implementation detail of the `EodhdLive` adapter.
- The layer constructor should acquire `HttpClient` and validate configuration,
  then build the service implementation.

Effect's v4 documentation explicitly recommends handling a service's own
dependencies during layer construction so they do not leak into the service
interface. [Managing Services](https://effect.website/docs/v4/requirements-management/services#handling-services-with-dependencies)

## What is idiomatic

Functions returning `Effect` values are the normal representation of reusable
effectful operations. The official Effect repository recommends `Effect.fn`
for reusable traced functions and `Effect.fnUntraced` when a tracing boundary
is not useful. [Effect's official LLM documentation](https://github.com/Effect-TS/effect/blob/main/LLMS.md#using-effectfn-and-effectfnuntraced)

Acquiring a dependency in a constructor effect and closing over it in service
methods is also an official pattern. The v4 layer guide acquires a
`FileSystem` while constructing `Cache`, defines `lookup` as a function using
that captured file-system value, and returns it as the service implementation.
[Managing Layers](https://effect.website/docs/v4/requirements-management/layers#defining-services-with-contextservice)

The closest first-party example to `EodhdLive` is Effect's HTTP client example. It:

1. creates a service with methods that return effects;
2. acquires and configures `HttpClient` in the service's layer construction
   effect;
3. defines methods such as `getTodo` with `Effect.fn`, closing over the
   configured client; and
4. provides the fetch implementation at the layer boundary.

[Official HTTP client service example](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/50_http-client/10_basics.ts)

Therefore, closure-based capture of `client` and `token` is not a sign that the
code failed to model effects correctly. The HTTP operation is still described
by the returned `Effect`; the outer JavaScript closure only supplies values
chosen when the service implementation is constructed.

## What was unnecessary in the original implementation

The original composition had two higher-order factories:

```ts
makeRetrieveSymbol(client, token) // returns RetrieveSymbol
makeRetrieve(retrieveSymbol)      // returns the public retrieve operation
```

Higher-order functions are legitimate, but neither factory represents an
independently managed resource or application capability. Turning
`retrieveSymbol` or `retrieveSymbols` into additional Effect services and
layers would make the dependency graph more granular without improving the
public abstraction. Layers are constructors for services and their dependency
graph, not a requirement for every helper function. [Managing Layers](https://effect.website/docs/v4/requirements-management/layers)

For this small service, a clearer structure is to keep the implementation
helpers at module scope and pass one explicit dependency record:

```ts
interface EodhdDependencies {
  readonly client: HttpClient.HttpClient
  readonly token: string
}

const retrieveSymbol = Effect.fn("Eodhd.retrieveSymbol")(
  function* (
    dependencies: EodhdDependencies,
    request: MarketDataRequest,
    symbol: string,
  ) {
    // Build, execute, decode, and map errors for one request.
  },
)

const retrieveSymbols = (
  dependencies: EodhdDependencies,
  request: MarketDataRequest,
) =>
  Effect.forEach(
    request.symbols,
    (symbol) => retrieveSymbol(dependencies, request, symbol),
    { concurrency: 1 },
  ).pipe(Effect.withSpan("Eodhd.retrieveSymbols"))

const retrieveDaily = Effect.fn("Eodhd.retrieveDaily")(
  function* (dependencies: EodhdDependencies, request: MarketDataRequest) {
    const entries = yield* retrieveSymbols(dependencies, request)
    return yield* validateOutput(Object.fromEntries(entries))
  },
)

const makeEodhd = (apiToken: unknown) =>
  Effect.gen(function* () {
    const token = yield* validateApiToken(apiToken)
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.acceptJson),
      HttpClient.filterStatusOk,
    )
    const dependencies = { client, token }

    return MarketData.of({
      retrieveDaily: (request) => retrieveDaily(dependencies, request),
    })
  })
```

This removes functions that return functions while preserving the two idiomatic
Effect properties:

- reusable operations return lazy `Effect` values;
- `HttpClient` is acquired while constructing the live adapter and does not
  appear in `MarketData.retrieveDaily`'s requirements.

The remaining adapter function is simply the implementation of the
`MarketData.retrieveDaily` method. An operation taking input and returning an
`Effect` is the expected interface shape, as illustrated by the official
`Database.query` and HTTP client service examples.

## Recommendation for `src/eodhd.ts`

Refactor away `makeRetrieveSymbol` and `makeRetrieve`, but do not introduce
more services or layers. Use top-level `retrieveSymbol`, `retrieveSymbols`, and
`retrieveDaily` functions that accept an `EodhdDependencies` record. Keep
`HttpClient` acquisition and token validation in `makeEodhd`, and keep the
public `MarketData.retrieveDaily` effect free of infrastructure requirements.

This is primarily a readability improvement. The current code is already
effectful and dependency-safe; its issue is unnecessary currying, not incorrect
Effect modeling.
