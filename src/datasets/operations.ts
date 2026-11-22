import { Effect } from "effect";

import { nowIso } from "$/clock";
import { RunArtifactStore } from "$/workflows/artifacts";
import type { Subject } from "$/workflows/contracts";

import {
  DatasetError,
  type PublishedDataset,
  publishedDatasetKey,
} from "./contracts";
import { PublicationStore, PublishedFileStore } from "./store";

const PARQUET = "application/vnd.apache.parquet";

/** What a publish step publishes, and who it is. */
export interface PublishRequest {
  readonly dataset: PublishedDataset;
  readonly subject: Subject;
  readonly processingDate: string;
  /** The run artifact holding the data (validated by the step's contract). */
  readonly artifact: {
    readonly id: string;
    readonly format: string;
    readonly schema: string;
  };
  readonly producer: {
    readonly workflowId: string;
    readonly runId: string;
    readonly stepId: string;
  };
}

/**
 * Publish a run artifact as the subject's current dataset: copy it to the
 * dataset's stable location, then record the publication. Metadata is
 * written only after the object write succeeded. Neither write is
 * conditional, so repeating the whole publication (after a lost response or
 * a failed metadata write) converges on the same object and record. A
 * failure before the copy leaves the previous publication untouched; this
 * is not a transaction across storage and D1.
 */
export const publishDataset = Effect.fn("Datasets.publish")(function* (
  request: PublishRequest,
) {
  const content = yield* RunArtifactStore.use((artifacts) =>
    artifacts.get(request.artifact.id),
  );
  if (content === null)
    return yield* new DatasetError({
      kind: "not_found",
      message: `The run artifact ${request.artifact.id} no longer exists; it may have expired`,
    });
  const body = yield* Effect.tryPromise({
    try: () => new Response(content.body).arrayBuffer(),
    catch: () =>
      new DatasetError({
        kind: "storage",
        message: "Could not read the run artifact",
      }),
  });
  const stored = yield* PublishedFileStore.use((datasets) =>
    datasets.put(
      publishedDatasetKey(request.dataset, request.subject),
      new Uint8Array(body),
      PARQUET,
    ),
  );
  const publishedAt = yield* nowIso;
  yield* PublicationStore.use((publications) =>
    publications.record({
      dataset: request.dataset,
      subject: request.subject,
      processingDate: request.processingDate,
      ...request.producer,
      sourceArtifact: request.artifact.id,
      format: request.artifact.format,
      schema: request.artifact.schema,
      etag: stored.etag,
      size: stored.size,
      publishedAt,
    }),
  );
});

/**
 * A dataset's current data by dataset and subject, from its stable
 * location. Data published before publication metadata existed (by the
 * legacy processor) is served too.
 */
export const currentDatasetData = Effect.fn("Datasets.currentData")(function* (
  dataset: PublishedDataset,
  subject: Subject,
) {
  const object = yield* PublishedFileStore.use((datasets) =>
    datasets.get(publishedDatasetKey(dataset, subject)),
  );
  if (object === null)
    return yield* new DatasetError({
      kind: "not_found",
      message: `No ${dataset} data has been published for this subject`,
    });
  return object;
});
