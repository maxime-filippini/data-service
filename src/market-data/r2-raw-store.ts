import { Effect, Layer } from "effect";

import { MarketDataError } from "$/market-data";
import {
  RawMarketDataStore,
  type StoreRawMarketData,
} from "$/market-data/ingestion";

const RAW_RESPONSE_VERSION = 1 as const;

export const rawMarketDataKey = (input: {
  readonly provider: string;
  readonly symbol: string;
  readonly runId: string;
}) =>
  `provider=${input.provider}/symbol=${input.symbol}/run=${input.runId}/response.json`;

const storageError = (message: string, symbol: string) =>
  new MarketDataError({
    kind: "storage",
    message,
    symbol,
  });

const observedRange = (input: StoreRawMarketData) => {
  let from: string | undefined;
  let to: string | undefined;

  for (const entry of input.entries) {
    from = from === undefined || entry.date < from ? entry.date : from;
    to = to === undefined || entry.date > to ? entry.date : to;
  }

  return from === undefined || to === undefined ? undefined : { from, to };
};

const store = (
  bucket: R2Bucket,
  input: StoreRawMarketData,
) =>
  Effect.gen(function* () {
    const key = rawMarketDataKey(input);
    const range = observedRange(input);
    const payload = {
      version: RAW_RESPONSE_VERSION,
      runId: input.runId,
      provider: input.provider,
      symbol: input.symbol,
      requestedRange: input.requestedRange,
      receivedAt: input.receivedAt,
      entries: input.entries,
    };

    const object = yield* Effect.tryPromise({
      try: () =>
        bucket.put(key, JSON.stringify(payload), {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: { contentType: "application/json" },
          customMetadata: {
            provider: input.provider,
            symbol: input.symbol,
            runId: input.runId,
            requestedFrom: input.requestedRange.from,
            requestedTo: input.requestedRange.to,
          },
        }),
      catch: () =>
        storageError("Could not store the raw ingestion response", input.symbol),
    });

    if (object === null) {
      return yield* Effect.fail(
        storageError(
          "An immutable raw object already exists for this ingestion run",
          input.symbol,
        ),
      );
    }

    return {
      key,
      etag: object.etag,
      ...(range === undefined ? {} : { observedRange: range }),
      rowCount: input.entries.length,
    };
  }).pipe(Effect.withSpan("R2RawMarketDataStore.store"));

/** R2 storage for one immutable validated provider response per run. */
export const R2RawMarketDataStoreLive = (
  bucket: R2Bucket,
): Layer.Layer<RawMarketDataStore> =>
  Layer.succeed(
    RawMarketDataStore,
    RawMarketDataStore.of({
      store: (input) => store(bucket, input),
    }),
  );
