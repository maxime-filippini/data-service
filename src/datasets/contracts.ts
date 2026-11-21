/**
 * Published datasets: request schemas, stable storage locations and expected
 * failures. A dataset is identified by its name and subject; its current
 * data lives at a stable location in the processed bucket, independent of
 * the temporary run artifact it was published from. Response types live in
 * `views.ts`.
 */

import { Schema } from "effect";

import { canonicalKey } from "$/market-data/schemas";
import { type Subject, SubjectKindSchema } from "$/workflows/contracts";

/** The datasets workflows can publish. */
export const PublishedDatasetSchema = Schema.Literals([
  "prices_eod",
  "portfolio_volatility",
]);
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

export type PublishedDataset = typeof PublishedDatasetSchema.Type;

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

/** The canonical object for a dataset and a subject of its supported kind. */
export const publishedDatasetKey = (
  dataset: PublishedDataset,
  subject: Subject,
) =>
  subject.kind === "asset"
    ? canonicalKey("prices_eod", subject.symbol)
    : `dataset=${dataset}/portfolio=${subject.id}/data.parquet`;

export type * from "./views";
