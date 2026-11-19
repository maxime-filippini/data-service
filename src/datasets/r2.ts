import { Effect, Layer } from "effect";

import { DatasetError } from "./contracts";
import { PublishedDatasets } from "./store";

const storageError = (message: string) =>
  new DatasetError({ kind: "storage", message });

/** Published dataset objects in the processed R2 bucket. */
export const R2PublishedDatasetsLive = (
  bucket: R2Bucket,
): Layer.Layer<PublishedDatasets> =>
  Layer.succeed(
    PublishedDatasets,
    PublishedDatasets.of({
      put: (key, body, contentType) =>
        Effect.tryPromise({
          try: () => bucket.put(key, body, { httpMetadata: { contentType } }),
          catch: () => storageError("Could not write the published dataset"),
        }).pipe(
          Effect.map((object) => ({ etag: object.etag, size: object.size })),
        ),
      get: (key) =>
        Effect.tryPromise({
          try: () => bucket.get(key),
          catch: () => storageError("Could not read the published dataset"),
        }).pipe(
          Effect.map((object) =>
            object === null
              ? null
              : {
                  body: object.body,
                  contentType:
                    object.httpMetadata?.contentType ??
                    "application/vnd.apache.parquet",
                  etag: object.etag,
                  size: object.size,
                },
          ),
        ),
    }),
  );
