import { Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { MarketDataError, MarketDataSource } from "$/market-data";
import { type DateRange } from "$/market-data/coverage";
import { EodEntriesSchema } from "$/market-data/schemas";

const ROOT_URL = "https://eodhd.com/api/eod";

const ApiTokenSchema = Schema.Trim.check(Schema.isNonEmpty());

// These decoders are functions that take an input and return
// Effect<T, Schema.SchemaError, never>
const decodeApiToken = Schema.decodeUnknownEffect(ApiTokenSchema);

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

// The Eodhd service implementation will need an HTTP client and an API token
interface EodhdDependencies {
  readonly client: HttpClient.HttpClient;
  readonly token: string;
}

const fetchSymbolRange = Effect.fn("Eodhd.fetchSymbolRange")(function* (
  dependencies: EodhdDependencies,
  symbol: string,
  range: DateRange,
) {
  const { client, token } = dependencies;

  return yield* client
    .get(`${ROOT_URL}/${symbol}`, {
      urlParams: {
        api_token: token,
        from: range.from,
        to: range.to,
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
});

const makeEodhd = (apiToken: unknown) =>
  Effect.gen(function* () {
    const token = yield* validateApiToken(apiToken);

    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.acceptJson),
      HttpClient.filterStatusOk,
    );

    const dependencies = { client, token } satisfies EodhdDependencies;

    return MarketDataSource.of({
      provider: "eodhd",
      retrieveDaily: (symbol, range) =>
        fetchSymbolRange(dependencies, symbol, range),
    });
  });

/** Builds the EODHD adapter while leaving its HTTP client injectable. */
export const EodhdMarketDataSource = (
  apiToken: unknown,
): Layer.Layer<MarketDataSource, MarketDataError, HttpClient.HttpClient> =>
  Layer.effect(MarketDataSource, makeEodhd(apiToken));

/** EODHD adapter backed by Cloudflare's global fetch implementation. */
export const EodhdMarketDataSourceLive = (
  apiToken: unknown,
): Layer.Layer<MarketDataSource, MarketDataError> =>
  EodhdMarketDataSource(apiToken).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
