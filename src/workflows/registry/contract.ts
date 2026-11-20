import { Schema } from "effect";

import { MarketDateSchema } from "$/market-data/schemas";
import {
  AssetSubjectSchema,
  PortfolioSubjectSchema,
} from "$/workflows/contracts";

/**
 * A named data contract: the explicit identity two step ports must share to
 * be connected, plus the schema their values satisfy. Save-time compatibility
 * compares identities; execution validates values with the schema. There is
 * no structural subtyping between contracts.
 */
export interface Contract<T = unknown> {
  readonly id: string;
  readonly description: string;
  readonly schema: Schema.Codec<T, unknown>;
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
export const assetSubject = defineContract({
  id: "asset-subject",
  description: "An asset subject: { kind: 'asset', symbol }",
  schema: AssetSubjectSchema,
});

/** The run's portfolio, from `context.subject` in a portfolio workflow. */
export const portfolioSubject = defineContract({
  id: "portfolio-subject",
  description: "A portfolio subject: { kind: 'portfolio', id }",
  schema: PortfolioSubjectSchema,
});

/** A calendar date, such as the run's processing date. */
export const date = defineContract({
  id: "date",
  description: "A calendar date in YYYY-MM-DD form",
  schema: MarketDateSchema,
});

/** Raw provider end-of-day prices, as written by the download step. */
export const rawPricesEod = defineContract({
  id: "raw-prices-eod",
  description:
    "An artifact reference to one provider's raw end-of-day price response (JSON)",
  schema: Schema.Struct({
    id: Schema.NonEmptyString,
    format: Schema.Literal("json"),
    schema: Schema.Literal("raw-prices-eod/v1"),
  }),
});
