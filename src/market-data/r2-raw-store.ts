import { Effect, Layer } from "effect";

import { MarketDataError } from "$/market-data";
import { RawMarketDataStore, type StoreRawMarketData } from "$/market-data/ingestion";

export const rawMarketDataKey = (input: {
  readonly dataset: string;
  readonly symbol: string;
  readonly runId: string;
}) => `dataset=${input.dataset}/symbol=${input.symbol}/run=${input.runId}.json`;

const storageError = (message: string, symbol: string) =>
  new MarketDataError({ kind: "storage", message, symbol });

const observedRange = (input: StoreRawMarketData) => {
  const dates = input.entries.map((entry) => entry.date).sort();
  return dates.length === 0 ? undefined : { from: dates[0]!, to: dates.at(-1)! };
};

/** R2 storage for one immutable validated provider response per run. */
export const R2RawMarketDataStoreLive = (bucket: R2Bucket): Layer.Layer<RawMarketDataStore> =>
  Layer.succeed(
    RawMarketDataStore,
    RawMarketDataStore.of({
      store: (input) =>
        Effect.gen(function* () {
          const key = rawMarketDataKey(input);
          const payload = {
            version: 1,
            runId: input.runId,
            dataset: input.dataset,
            provider: input.provider,
            symbol: input.symbol,
            requestedRange: input.requestedRange,
            receivedAt: input.receivedAt,
            entries: input.entries,
          };

          const object = yield* Effect.tryPromise({
            try: () =>
              bucket.put(key, JSON.stringify(payload), {
                // Raw objects are write-once.
                onlyIf: new Headers({ "If-None-Match": "*" }),
                httpMetadata: { contentType: "application/json" },
              }),
            catch: () => storageError("Could not store the raw ingestion response", input.symbol),
          });

          if (object === null) {
            return yield* Effect.fail(
              storageError("A raw object already exists for this ingestion run", input.symbol),
            );
          }

          const range = observedRange(input);
          return {
            key,
            etag: object.etag,
            rowCount: input.entries.length,
            ...(range === undefined ? {} : { observedRange: range }),
          };
        }).pipe(Effect.withSpan("R2RawMarketDataStore.store")),
    }),
  );
