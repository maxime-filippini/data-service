import { Effect, Schema } from "effect";

import {
  RunArtifacts,
  runArtifactId,
  type ArtifactError,
} from "$/workflows/artifacts";

import type { ArtifactReference } from "./contract";
import { terminal, transient, type StepExecution } from "./step-type";

// Bounds buffered JSON, with room for all 5,000 holdings/publications.
const MAX_JSON_ARTIFACT_BYTES = 8 * 1024 * 1024;

const artifactFailure = (error: ArtifactError) =>
  error.kind === "storage" ? transient(error.message) : terminal(error.message);

/** A retry always writes to the same run/step location. */
export const jsonArtifactReference = <S extends string>(
  execution: StepExecution,
  name: string,
  schema: S,
) => ({
  id: runArtifactId({ ...execution, name, format: "json" }),
  format: "json" as const,
  schema,
});

export const writeJsonArtifact = <A>(
  reference: ArtifactReference,
  schema: Schema.Codec<A, unknown>,
  value: A,
) =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknownEffect(schema, {
      onExcessProperty: "error",
    })(value).pipe(
      Effect.mapError(() =>
        terminal(`Artifact ${reference.id} does not match ${reference.schema}`),
      ),
    );
    const body = JSON.stringify(validated);
    if (new TextEncoder().encode(body).byteLength > MAX_JSON_ARTIFACT_BYTES)
      return yield* terminal(
        `JSON artifact exceeds ${MAX_JSON_ARTIFACT_BYTES} bytes`,
      );
    yield* RunArtifacts.use((artifacts) =>
      artifacts.put(reference.id, body, "application/json"),
    ).pipe(Effect.mapError(artifactFailure));
  });

/** Missing data stays missing; callers must never re-resolve it from live state. */
export const readJsonArtifact = <A>(
  reference: ArtifactReference,
  schema: Schema.Codec<A, unknown>,
) =>
  Effect.gen(function* () {
    const content = yield* RunArtifacts.use((artifacts) =>
      artifacts.get(reference.id),
    ).pipe(Effect.mapError(artifactFailure));
    if (content === null) return null;

    const text = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => new Response(content.body).body!.getReader(),
        catch: () => transient("Could not read the JSON run artifact"),
      }),
      (reader) =>
        Effect.gen(function* () {
          const decoder = new TextDecoder();
          let bytes = 0;
          let text = "";
          while (true) {
            const { done, value } = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: () => transient("Could not read the JSON run artifact"),
            });
            if (done) return text + decoder.decode();
            bytes += value.byteLength;
            if (bytes > MAX_JSON_ARTIFACT_BYTES)
              return yield* terminal(
                `JSON artifact exceeds ${MAX_JSON_ARTIFACT_BYTES} bytes`,
              );
            text += decoder.decode(value, { stream: true });
          }
        }),
      (reader) =>
        Effect.tryPromise(() => reader.cancel()).pipe(
          // Cleanup must not replace the read's failure or interruption.
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => reader.releaseLock())),
        ),
    );
    const value = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => terminal(`Artifact ${reference.id} is not valid JSON`),
    });
    return yield* Schema.decodeUnknownEffect(schema, {
      onExcessProperty: "error",
    })(value).pipe(
      Effect.mapError(() =>
        terminal(`Artifact ${reference.id} does not match ${reference.schema}`),
      ),
    );
  });
