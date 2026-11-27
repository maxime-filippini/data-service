import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { Effect, Layer } from "effect";

import { DatasetError } from "$/datasets/contracts";
import { PublishedFileStore } from "$/datasets/store";

const PARQUET = "application/vnd.apache.parquet";

const storageError = (message: string) =>
  new DatasetError({ kind: "storage", message });

/** An MD5 ETag, like R2's for a single-part upload. */
const etagOf = (body: Uint8Array) =>
  createHash("md5").update(body).digest("hex");

/**
 * Published datasets as files under a directory standing in for the
 * processed bucket: a key maps to the same relative path. Writes go through
 * a temporary file, so a reader never sees half an object.
 */
export const FilePublishedFileStoreLive = (
  root: string,
): Layer.Layer<PublishedFileStore> => {
  const pathOf = (key: string) => {
    const path = resolve(root, key);
    if (!path.startsWith(resolve(root) + sep))
      throw new Error(`Invalid dataset key ${key}`);
    return path;
  };
  return Layer.succeed(
    PublishedFileStore,
    PublishedFileStore.of({
      put: (key, body) =>
        Effect.tryPromise({
          try: async () => {
            const path = pathOf(key);
            await mkdir(dirname(path), { recursive: true });
            const temporary = `${path}.${crypto.randomUUID()}.tmp`;
            await writeFile(temporary, body);
            await rename(temporary, path);
            return { etag: etagOf(body), size: body.byteLength };
          },
          catch: () => storageError("Could not write the published dataset"),
        }),
      get: (key) =>
        Effect.tryPromise({
          try: () =>
            readFile(pathOf(key)).then(
              (bytes) => {
                const body = new Uint8Array(bytes);
                return {
                  body,
                  contentType: PARQUET,
                  etag: etagOf(body),
                  size: body.byteLength,
                };
              },
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
              },
            ),
          catch: () => storageError("Could not read the published dataset"),
        }),
      etag: (key) =>
        Effect.tryPromise({
          try: () =>
            readFile(pathOf(key)).then(
              etagOf,
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
              },
            ),
          catch: () => storageError("Could not check the published dataset"),
        }),
    }),
  );
};

/**
 * In-memory published datasets, for tests. `objects` holds what was
 * written; `failPuts` makes the next writes fail, as an outage would.
 */
export const memoryPublishedFileStore = () => {
  const objects = new Map<string, Uint8Array>();
  const faults = { failPuts: 0 };
  const layer = Layer.succeed(
    PublishedFileStore,
    PublishedFileStore.of({
      put: (key, body) =>
        Effect.suspend(() => {
          if (faults.failPuts > 0) {
            faults.failPuts -= 1;
            return Effect.fail(
              storageError("Could not write the published dataset"),
            );
          }
          objects.set(key, body);
          return Effect.succeed({ etag: etagOf(body), size: body.byteLength });
        }),
      get: (key) =>
        Effect.sync(() => {
          const body = objects.get(key);
          return body === undefined
            ? null
            : {
                body,
                contentType: PARQUET,
                etag: etagOf(body),
                size: body.byteLength,
              };
        }),
      etag: (key) =>
        Effect.sync(() => {
          const body = objects.get(key);
          return body === undefined ? null : etagOf(body);
        }),
    }),
  );
  return { objects, faults, layer };
};
