import { Effect, Layer, Schema } from "effect";

import {
  MarketDataCache,
  type MarketDataCacheKey,
  MarketDataError,
  type StoreMarketData,
} from "$/market-data";

import { mergeDateRanges, type DateRange } from "$/market-data/coverage";

import {
  type EodEntry,
  EodEntrySchema,
  MarketDateSchema,
} from "$/market-data/schemas";

const MANIFEST_VERSION = 1 as const;

const CoverageRangeSchema = Schema.Struct({
  from: MarketDateSchema,
  to: MarketDateSchema,
}).check(
  Schema.makeFilter<{ readonly from: string; readonly to: string }>((range) =>
    range.from <= range.to
      ? true
      : { path: ["to"], issue: "Coverage must end on or after it starts" },
  ),
);

const CacheManifestSchema = Schema.Struct({
  version: Schema.Literal(MANIFEST_VERSION),
  coverage: Schema.Array(CoverageRangeSchema),
  updatedAt: Schema.String,
});

type CacheManifest = typeof CacheManifestSchema.Type;

const decodeManifest = Schema.decodeUnknownEffect(CacheManifestSchema, {
  errors: "all",
});

const decodeEntry = Schema.decodeUnknownEffect(EodEntrySchema, {
  errors: "all",
});

const storageError = (message: string, symbol: string) =>
  new MarketDataError({
    kind: "storage",
    message,
    symbol,
  });

const symbolPrefix = (key: MarketDataCacheKey) =>
  `provider=${key.provider}/symbol=${key.symbol}`;

const manifestKey = (key: MarketDataCacheKey) =>
  `${symbolPrefix(key)}/_manifest.json`;

const dailyPrefix = (key: MarketDataCacheKey) => `${symbolPrefix(key)}/date=`;

const dailyKey = (key: MarketDataCacheKey, date: string) =>
  `${dailyPrefix(key)}${date}.json`;

const emptyManifest = (): CacheManifest => ({
  version: MANIFEST_VERSION,
  coverage: [],
  updatedAt: new Date(0).toISOString(),
});

interface ManifestWithEtag {
  readonly manifest: CacheManifest;
  readonly etag?: string;
}

const readManifest = Effect.fn("R2MarketDataCache.readManifest")(function* (
  bucket: R2Bucket,
  key: MarketDataCacheKey,
): Effect.fn.Return<ManifestWithEtag, MarketDataError> {
  const object = yield* Effect.tryPromise({
    try: () => bucket.get(manifestKey(key)),
    catch: () => storageError("Could not read the cache manifest", key.symbol),
  });

  if (object === null) {
    return { manifest: emptyManifest() };
  }

  const input = yield* Effect.tryPromise({
    try: () => object.json<unknown>(),
    catch: () => storageError("Could not parse the cache manifest", key.symbol),
  });

  const manifest = yield* decodeManifest(input).pipe(
    Effect.mapError(() =>
      storageError("The cache manifest did not match its schema", key.symbol),
    ),
  );

  return {
    manifest: {
      ...manifest,
      coverage: mergeDateRanges(manifest.coverage),
    },
    etag: object.etag,
  };
});

const putManifest = (
  bucket: R2Bucket,
  key: MarketDataCacheKey,
  current: ManifestWithEtag,
  addedCoverage: readonly DateRange[],
) => {
  const manifest: CacheManifest = {
    version: MANIFEST_VERSION,
    coverage: mergeDateRanges([...current.manifest.coverage, ...addedCoverage]),
    updatedAt: new Date().toISOString(),
  };

  return Effect.tryPromise({
    try: () =>
      bucket.put(manifestKey(key), JSON.stringify(manifest), {
        onlyIf:
          current.etag === undefined
            ? new Headers({ "If-None-Match": "*" })
            : { etagMatches: current.etag },
        httpMetadata: { contentType: "application/json" },
        customMetadata: { provider: key.provider, symbol: key.symbol },
      }),
    catch: () =>
      storageError("Could not update the cache manifest", key.symbol),
  });
};

/** Merge coverage using an optimistic compare-and-swap update. */
const addManifestCoverage = (
  bucket: R2Bucket,
  key: MarketDataCacheKey,
  addedCoverage: readonly DateRange[],
): Effect.Effect<void, MarketDataError> => {
  const attempt = (
    remainingAttempts: number,
  ): Effect.Effect<void, MarketDataError> =>
    Effect.gen(function* () {
      const current = yield* readManifest(bucket, key);
      const result = yield* putManifest(bucket, key, current, addedCoverage);

      if (result !== null) {
        return;
      }

      if (remainingAttempts <= 1) {
        return yield* Effect.fail(
          storageError("The cache manifest changed too many times", key.symbol),
        );
      }

      return yield* attempt(remainingAttempts - 1);
    });

  return addedCoverage.length === 0 ? Effect.void : attempt(3);
};

const extractDate = (objectKey: string, prefix: string) => {
  if (!objectKey.startsWith(prefix) || !objectKey.endsWith(".json")) {
    return undefined;
  }

  return objectKey.slice(prefix.length, -".json".length);
};

const listDailyKeys = Effect.fn("R2MarketDataCache.listDailyKeys")(function* (
  bucket: R2Bucket,
  key: MarketDataCacheKey,
  range: DateRange,
): Effect.fn.Return<readonly string[], MarketDataError> {
  const prefix = dailyPrefix(key);
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const page = yield* Effect.tryPromise({
      try: () => bucket.list({ prefix, cursor, limit: 1000 }),
      catch: () =>
        storageError("Could not list cached market data", key.symbol),
    });

    for (const object of page.objects) {
      const date = extractDate(object.key, prefix);

      if (date !== undefined && date >= range.from && date <= range.to) {
        keys.push(object.key);
      }
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  return keys.sort();
});

const readDailyEntries = Effect.fn("R2MarketDataCache.readDailyEntries")(
  function* (
    bucket: R2Bucket,
    key: MarketDataCacheKey,
    range: DateRange,
  ): Effect.fn.Return<readonly EodEntry[], MarketDataError> {
    const keys = yield* listDailyKeys(bucket, key, range);

    return yield* Effect.forEach(
      keys,
      (objectKey) =>
        Effect.gen(function* () {
          const object = yield* Effect.tryPromise({
            try: () => bucket.get(objectKey),
            catch: () =>
              storageError("Could not read cached market data", key.symbol),
          });

          if (object === null) {
            return yield* Effect.fail(
              storageError(
                "Cached market data disappeared while reading",
                key.symbol,
              ),
            );
          }

          const input = yield* Effect.tryPromise({
            try: () => object.json<unknown>(),
            catch: () =>
              storageError("Could not parse cached market data", key.symbol),
          });

          return yield* decodeEntry(input).pipe(
            Effect.mapError(() =>
              storageError(
                "Cached market data did not match its schema",
                key.symbol,
              ),
            ),
          );
        }),
      { concurrency: 5 },
    );
  },
);

const writeDailyEntries = Effect.fn("R2MarketDataCache.writeDailyEntries")(
  function* (
    bucket: R2Bucket,
    key: MarketDataCacheKey,
    entries: readonly EodEntry[],
    overwrite: boolean,
  ): Effect.fn.Return<void, MarketDataError> {
    yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.tryPromise({
          try: () =>
            bucket.put(dailyKey(key, entry.date), JSON.stringify(entry), {
              ...(overwrite
                ? {}
                : {
                    onlyIf: new Headers({ "If-None-Match": "*" }),
                  }),
              httpMetadata: { contentType: "application/json" },
              customMetadata: {
                provider: key.provider,
                symbol: key.symbol,
                date: entry.date,
              },
            }),
          catch: () =>
            storageError(
              "Could not write market data to the cache",
              key.symbol,
            ),
        }),
      { concurrency: 5 },
    );
  },
);

const store = (bucket: R2Bucket, input: StoreMarketData) =>
  Effect.gen(function* () {
    yield* writeDailyEntries(bucket, input.key, input.entries, input.overwrite);
    yield* addManifestCoverage(bucket, input.key, input.coverage);
  }).pipe(Effect.withSpan("R2MarketDataCache.store"));

/** R2-backed storage for canonical, validated market data. */
export const R2MarketDataCacheLive = (
  bucket: R2Bucket,
): Layer.Layer<MarketDataCache> =>
  Layer.succeed(
    MarketDataCache,
    MarketDataCache.of({
      readCoverage: (key) =>
        readManifest(bucket, key).pipe(
          Effect.map(({ manifest }) => manifest.coverage),
        ),
      readEntries: (key, range) => readDailyEntries(bucket, key, range),
      store: (input) => store(bucket, input),
    }),
  );
