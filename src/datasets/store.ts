import { Context, type Effect } from "effect";

import type { Subject } from "$/workflows/contracts";

import type {
  DatasetError,
  PublishedDataset,
  PublicationView,
} from "./contracts";

/** What a publication records once its object write succeeded. */
export interface PublicationRecord {
  readonly dataset: PublishedDataset;
  readonly subject: Subject;
  readonly processingDate: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly sourceArtifact: string;
  readonly format: string;
  readonly schema: string;
  readonly etag: string;
  readonly size: number;
  readonly publishedAt: string;
}

/** Which publications to list. */
export interface PublicationFilter {
  readonly subject?: { readonly kind: string; readonly id?: string };
  readonly dataset?: PublishedDataset;
}

/**
 * Injectable publication metadata (D1). One row per dataset and subject,
 * replaced by each publication. Recording is an upsert, so repeating it
 * after an uncertain failure is safe.
 */
export class DatasetPublications extends Context.Service<
  DatasetPublications,
  {
    readonly record: (
      publication: PublicationRecord,
    ) => Effect.Effect<void, DatasetError>;
    readonly list: (
      filter: PublicationFilter,
    ) => Effect.Effect<readonly PublicationView[], DatasetError>;
    /** `not_found` when the dataset has never been published for the subject. */
    readonly get: (
      dataset: PublishedDataset,
      subject: Subject,
    ) => Effect.Effect<PublicationView, DatasetError>;
  }
>()("data-service/DatasetPublications") {}

/** A stored dataset object. */
export interface DatasetObject {
  readonly body: ReadableStream | Uint8Array;
  readonly contentType: string;
  readonly etag: string;
  readonly size: number;
}

/**
 * Injectable storage for published dataset objects: the processed R2 bucket
 * in the Worker, files locally. Keys come only from `publishedDatasetKey`.
 */
export class PublishedDatasets extends Context.Service<
  PublishedDatasets,
  {
    /** Write (or replace) an object; returns its ETag and size. */
    readonly put: (
      key: string,
      body: Uint8Array,
      contentType: string,
    ) => Effect.Effect<
      { readonly etag: string; readonly size: number },
      DatasetError
    >;
    /** An object, or null when there is none. */
    readonly get: (
      key: string,
    ) => Effect.Effect<DatasetObject | null, DatasetError>;
  }
>()("data-service/PublishedDatasets") {}
