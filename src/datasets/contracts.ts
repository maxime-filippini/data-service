/**
 * Published datasets: request schemas, stable storage locations and expected
 * failures. A dataset is identified by its name and subject; its current
 * data lives at a stable location in the processed bucket, independent of
 * the temporary run artifact it was published from. Response types live in
 * `views.ts`.
 */

import { Schema } from "effect";

import { type Subject, SubjectKindSchema } from "$/workflows/contracts";

/** The datasets workflows can publish. */
export const PublishedDatasetSchema = Schema.Literals([
  "prices_eod",
  "portfolio_volatility",
]);
export type PublishedDataset = typeof PublishedDatasetSchema.Type;

/** The subject kind and artifact schema required by each dataset. */
export const PUBLISHED_DATASETS = {
  prices_eod: { subjectKind: "asset", schema: "prices-eod/v1" },
  portfolio_volatility: {
    subjectKind: "portfolio",
    schema: "portfolio-volatility/v1",
  },
} as const satisfies Record<
  PublishedDataset,
  { readonly subjectKind: Subject["kind"]; readonly schema: string }
>;

/**
 * Where a dataset's current data lives in the processed bucket. Asset
 * datasets keep the location existing consumers read (the app's explorer,
 * calculations): `dataset=<name>/symbol=<SYMBOL>/data.parquet`.
 */
export const publishedDatasetKey = (
  dataset: PublishedDataset,
  subject: Subject,
) =>
  subject.kind === "asset"
    ? `dataset=${dataset}/symbol=${subject.symbol}/data.parquet`
    : `dataset=${dataset}/portfolio=${subject.id}/data.parquet`;

/** Query filters for listing publications. */
export const PublicationsQuerySchema = Schema.Struct({
  subjectKind: Schema.optionalKey(SubjectKindSchema),
  subjectId: Schema.optionalKey(Schema.NonEmptyString),
  dataset: Schema.optionalKey(PublishedDatasetSchema),
});

/** Path parameters naming one dataset of one subject. */
export const PublicationParamsSchema = Schema.Struct({
  dataset: PublishedDatasetSchema,
  subjectKind: SubjectKindSchema,
  subjectId: Schema.NonEmptyString,
});

/**
 * Expected failure reading or publishing datasets: no publication or data,
 * a database outage, or object storage failing.
 */
export class DatasetError extends Schema.TaggedError<DatasetError>()(
  "DatasetError",
  {
    kind: Schema.Literals(["not_found", "database", "storage"]),
    message: Schema.String,
  },
) {}

export type * from "./views";
