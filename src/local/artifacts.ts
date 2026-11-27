import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect, Layer } from "effect";

import {
  ArtifactError,
  requireArtifactId,
  RunArtifactStore,
} from "$/workflows/artifacts";

const CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  parquet: "application/vnd.apache.parquet",
};

const contentTypeOf = (id: string) =>
  CONTENT_TYPES[id.slice(id.lastIndexOf(".") + 1)] ??
  "application/octet-stream";

const storageError = (message: string) =>
  new ArtifactError({ kind: "storage", message });

/**
 * Run artifacts as files under a controlled directory: an artifact ID maps
 * to the same relative path (`<root>/runs/<runId>/<stepId>/<name>.<ext>`).
 * IDs are validated first, so nothing is written outside the directory.
 */
export const FileRunArtifactStoreLive = (
  root: string,
): Layer.Layer<RunArtifactStore> =>
  Layer.succeed(
    RunArtifactStore,
    RunArtifactStore.of({
      put: (id, body) =>
        requireArtifactId(id).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: async () => {
                const path = join(root, id);
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, body);
              },
              catch: () => storageError("Could not write the run artifact"),
            }),
          ),
        ),
      get: (id) =>
        requireArtifactId(id).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () =>
                readFile(join(root, id)).then(
                  (bytes) => ({
                    body: new Uint8Array(bytes),
                    contentType: contentTypeOf(id),
                  }),
                  (error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return null;
                    throw error;
                  },
                ),
              catch: () => storageError("Could not read the run artifact"),
            }),
          ),
        ),
    }),
  );

/** In-memory run artifacts, for tests. `objects` holds what was written. */
export const memoryRunArtifacts = () => {
  const objects = new Map<string, string | Uint8Array>();
  const layer = Layer.succeed(
    RunArtifactStore,
    RunArtifactStore.of({
      put: (id, body) =>
        requireArtifactId(id).pipe(
          Effect.andThen(Effect.sync(() => void objects.set(id, body))),
        ),
      get: (id) =>
        requireArtifactId(id).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const body = objects.get(id);
              return body === undefined
                ? null
                : { body, contentType: contentTypeOf(id) };
            }),
          ),
        ),
    }),
  );
  return { objects, layer };
};
