import { Context, Effect, Layer, Schema } from "effect";

/**
 * Temporary run artifacts: data too large for a step's checkpointed output,
 * stored under the run's own namespace (`runs/<runId>/<stepId>/<name>.<ext>`)
 * and passed between steps as an artifact reference. Writes to the same ID
 * replace the object, so a retried step can write again safely. Only IDs in
 * the run namespace reach a storage adapter; there are no arbitrary paths.
 */

const ARTIFACT_ID =
  /^runs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z][A-Za-z0-9_-]{0,63}\/[A-Za-z][A-Za-z0-9_-]{0,63}\.(?:json|parquet)$/u;

/** Whether an artifact ID is a valid run-namespace ID. */
export const isArtifactId = (id: string) => ARTIFACT_ID.test(id);

/** The ID of a step's artifact in the run namespace. */
export const runArtifactId = (input: {
  readonly runId: string;
  readonly stepId: string;
  readonly name: string;
  readonly format: "json" | "parquet";
}) => `runs/${input.runId}/${input.stepId}/${input.name}.${input.format}`;

/** Expected failure reading or writing an artifact. */
export class ArtifactError extends Schema.TaggedError<ArtifactError>()(
  "ArtifactError",
  {
    kind: Schema.Literals(["invalid", "storage"]),
    message: Schema.String,
  },
) {}

/** A stored artifact's contents. */
export interface ArtifactContent {
  readonly body: ReadableStream | Uint8Array | string;
  readonly contentType: string;
}

/** Injectable artifact storage: R2 in the Worker, files locally. */
export class RunArtifacts extends Context.Service<
  RunArtifacts,
  {
    /** Write (or replace) an artifact. */
    readonly put: (
      id: string,
      body: string | Uint8Array,
      contentType: string,
    ) => Effect.Effect<void, ArtifactError>;
    /** An artifact's contents, or null when it does not exist. */
    readonly get: (
      id: string,
    ) => Effect.Effect<ArtifactContent | null, ArtifactError>;
  }
>()("data-service/RunArtifacts") {}

/** Fail unless the ID is in the run namespace. */
export const requireArtifactId = (id: string) =>
  isArtifactId(id)
    ? Effect.void
    : Effect.fail(
        new ArtifactError({
          kind: "invalid",
          message: `"${id}" is not a run artifact ID`,
        }),
      );

const storageError = (message: string) =>
  new ArtifactError({ kind: "storage", message });

/** Run artifacts in an R2 bucket, under its `runs/` prefix. */
export const R2RunArtifactsLive = (
  bucket: R2Bucket,
): Layer.Layer<RunArtifacts> =>
  Layer.succeed(
    RunArtifacts,
    RunArtifacts.of({
      put: (id, body, contentType) =>
        requireArtifactId(id).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () =>
                bucket.put(id, body, { httpMetadata: { contentType } }),
              catch: () => storageError("Could not store the run artifact"),
            }),
          ),
          Effect.asVoid,
        ),
      get: (id) =>
        requireArtifactId(id).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => bucket.get(id),
              catch: () => storageError("Could not read the run artifact"),
            }),
          ),
          Effect.map((object) =>
            object === null
              ? null
              : {
                  body: object.body,
                  contentType:
                    object.httpMetadata?.contentType ??
                    "application/octet-stream",
                },
          ),
        ),
    }),
  );
