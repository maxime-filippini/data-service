import { Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { MarketData, MarketDataError } from "$/market-data";
import {
  EodEntriesBySymbolSchema,
  EodEntriesSchema,
  type MarketDataRequest,
} from "$/market-data/schemas";

const ROOT_URL = "https://eodhd.com/api/eod";

const ApiTokenSchema = Schema.Trim.check(Schema.isNonEmpty());

// These decoders are functions that take an input and return
// Effect<T, Schema.SchemaError, never>
const decodeApiToken = Schema.decodeUnknownEffect(ApiTokenSchema);
const decodeEodEntries = Schema.decodeUnknownEffect(EodEntriesBySymbolSchema, {
  errors: "all",
});

const validateApiToken = (input: unknown) =>
  decodeApiToken(input).pipe(
    Effect.mapError(
      () =>
        new MarketDataError({
          kind: "configuration",
          message: "EODHD_API_TOKEN is missing or empty",
        }),
    ),
  );

const validateOutput = (input: unknown) =>
  decodeEodEntries(input).pipe(
    Effect.mapError(
      () =>
        new MarketDataError({
          kind: "response",
          message: "Could not construct the market-data response",
        }),
    ),
  );

// The Eodhd service implementation will need an HTTP client and an API token
interface EodhdDependencies {
  readonly client: HttpClient.HttpClient;
  readonly token: string;
}

// Effect.fn allows us to trace the generator call
const retrieveSymbol = Effect.fn("Eodhd.retrieveSymbol")(function* (
  dependencies: EodhdDependencies,
  request: MarketDataRequest,
  symbol: string,
) {
  const { client, token } = dependencies;

  const data = yield* client
    .get(`${ROOT_URL}/${symbol}`, {
      urlParams: {
        api_token: token,
        from: request.from,
        to: request.to,
        period: "d",
        order: "a",
        fmt: "json",
      },
    })
    .pipe(
      // EODHD authenticates in the query string. Do not put its token into
      // Effect's automatic HTTP client span attributes.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(EodEntriesSchema, {
          errors: "all",
        }),
      ),
      Effect.mapError(
        (cause) =>
          new MarketDataError({
            kind: cause._tag === "SchemaError" ? "response" : "request",
            message:
              cause._tag === "SchemaError"
                ? "EODHD returned data that did not match its schema"
                : "The EODHD request failed",
            symbol,
          }),
      ),
    );

  return [symbol, data] as const;
});

const retrieveSymbols = (
  dependencies: EodhdDependencies,
  request: MarketDataRequest,
) =>
  Effect.forEach(
    request.symbols,
    (symbol) => retrieveSymbol(dependencies, request, symbol),
    // Avoid an accidental burst of billed API calls.
    { concurrency: 1 },
  ).pipe(Effect.withSpan("Eodhd.retrieveSymbols"));

const retrieveDaily = Effect.fn("Eodhd.retrieveDaily")(function* (
  dependencies: EodhdDependencies,
  request: MarketDataRequest,
) {
  const entries = yield* retrieveSymbols(dependencies, request);
  return yield* validateOutput(Object.fromEntries(entries));
});

const makeEodhd = (apiToken: unknown) =>
  Effect.gen(function* () {
    const token = yield* validateApiToken(apiToken);

    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.acceptJson),
      HttpClient.filterStatusOk,
    );

    const dependencies = { client, token } satisfies EodhdDependencies;

    return MarketData.of({
      retrieveDaily: (request) => retrieveDaily(dependencies, request),
    });
  });

/** Builds the EODHD adapter while leaving its HTTP client injectable. */
export const EodhdMarketData = (
  apiToken: unknown,
): Layer.Layer<MarketData, MarketDataError, HttpClient.HttpClient> =>
  Layer.effect(MarketData, makeEodhd(apiToken));

/** EODHD adapter backed by Cloudflare's global fetch implementation. */
export const EodhdMarketDataLive = (
  apiToken: unknown,
): Layer.Layer<MarketData, MarketDataError> =>
  EodhdMarketData(apiToken).pipe(Layer.provide(FetchHttpClient.layer));
