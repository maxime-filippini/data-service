import { Schema } from "effect";

import { PublishedDatasetSchema } from "$/datasets/contracts";
import { MarketDateSchema } from "$/market-data/schemas";
import {
  PortfolioVolatilityReference,
  PortfolioVolatilitySummary,
  PricesEodReference,
  RawPricesEodReference,
} from "$/operations/contracts.generated";
import { HoldingsSchema, MAX_SNAPSHOT_HOLDINGS } from "$/portfolios/contracts";
import {
  AssetSubjectSchema,
  PortfolioSubjectSchema,
  SubjectSchema,
  WorkflowIdSchema,
} from "$/workflows/contracts";
import { RunIdSchema } from "$/workflows/runs/contracts";
import type { SubjectKind } from "$/workflows/subjects";

/**
 * A named data contract: the explicit identity two step ports must share to
 * be connected, plus the schema their values satisfy. Save-time compatibility
 * compares identities and explicitly accepted alternatives. Execution validates
 * the resolved value with the input schema.
 *
 * A contract describes a value, not the value itself: an input whose
 * contract is `assetSubjectContract` requires an asset subject.
 */
export interface Contract<T = unknown> {
  readonly id: string;
  readonly description: string;
  readonly schema: Schema.Codec<T, unknown>;
  /** Other registered output contracts explicitly accepted as input. */
  readonly accepts?: readonly string[];
}

/** Declare a contract, keeping its value type for step implementations. */
export const defineContract = <T>(contract: Contract<T>): Contract<T> =>
  contract;

/**
 * A small descriptor for persisted data passed between steps instead of the
 * data itself: an opaque storage identity plus its format and schema. Storage
 * adapters resolve the identity; the descriptor holds no bucket or path.
 */
export const ArtifactReferenceSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  format: Schema.Literals(["json", "parquet"]),
  schema: Schema.NonEmptyString,
});

export type ArtifactReference = typeof ArtifactReferenceSchema.Type;

/** The run's asset, from `context.subject` in an asset workflow. */
export const assetSubjectContract = defineContract({
  id: "asset-subject",
  description: "An asset subject: { kind: 'asset', symbol }",
  schema: AssetSubjectSchema,
});

/** The run's portfolio, from `context.subject` in a portfolio workflow. */
export const portfolioSubjectContract = defineContract({
  id: "portfolio-subject",
  description: "A portfolio subject: { kind: 'portfolio', id }",
  schema: PortfolioSubjectSchema,
});

/** The contract of `context.subject`, for each definition scope. */
export const subjectContracts = {
  asset: assetSubjectContract,
  portfolio: portfolioSubjectContract,
} as const satisfies Record<SubjectKind, Contract<any>>;

/** A calendar date, such as the run's processing date. */
export const dateContract = defineContract({
  id: "date",
  description: "A calendar date in YYYY-MM-DD form",
  schema: MarketDateSchema,
});

/**
 * Raw provider end-of-day prices, as written by the download step. The
 * schema is generated from the Python service's Pydantic contract.
 */
export const rawPricesEodContract = defineContract({
  id: "raw-prices-eod",
  description:
    "An artifact reference to one provider's raw end-of-day price response (JSON)",
  schema: RawPricesEodReference,
});

/** Normalized end-of-day prices, as the Python normalization writes them. */
export const pricesEodContract = defineContract({
  id: "prices-eod",
  description:
    "An artifact reference to normalized end-of-day prices (Parquet, prices_eod columns)",
  schema: PricesEodReference,
});

export const portfolioVolatilityDataContract = defineContract({
  id: "portfolio-volatility-data",
  description: "An artifact reference to portfolio volatility data in Parquet",
  schema: PortfolioVolatilityReference,
});

export const portfolioVolatilitySummaryContract = defineContract({
  id: "portfolio-volatility-summary",
  description:
    "Annualised volatility, the return window and the effective holdings date",
  schema: PortfolioVolatilitySummary,
});

export const publishableDatasetContract = defineContract({
  id: "publishable-dataset",
  description: "A normalized prices or portfolio volatility Parquet artifact",
  schema: Schema.Union([PricesEodReference, PortfolioVolatilityReference]),
  accepts: [pricesEodContract.id, portfolioVolatilityDataContract.id],
});

/** What a publish step published: look it up by dataset and subject. */
export const datasetPublicationContract = defineContract({
  id: "dataset-publication",
  description:
    "A published dataset: its name, subject and processing date (retrieve it through the dataset API)",
  schema: Schema.Struct({
    dataset: PublishedDatasetSchema,
    subject: SubjectSchema,
    processingDate: MarketDateSchema,
  }),
});

export const portfolioHoldingsContract = defineContract({
  id: "holdings",
  description: "A portfolio's effective asset symbols and weights",
  schema: HoldingsSchema,
});

export const assetSubjectsContract = defineContract({
  id: "asset-subjects",
  description: "Distinct asset subjects required by a portfolio",
  schema: Schema.Array(AssetSubjectSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_SNAPSHOT_HOLDINGS),
    Schema.makeFilter(
      (assets) =>
        new Set(assets.map(({ symbol }) => symbol)).size === assets.length ||
        "Each asset can appear only once",
    ),
  ),
});

export const publishedAssetPricesContract = defineContract({
  id: "published-asset-prices",
  description:
    "Current published prices for each required asset, with the matching processing date and upstream run",
  schema: Schema.Array(
    Schema.Struct({
      dataset: Schema.Literal("prices_eod"),
      subject: AssetSubjectSchema,
      processingDate: MarketDateSchema,
      workflowId: WorkflowIdSchema,
      runId: RunIdSchema,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SNAPSHOT_HOLDINGS)),
});
