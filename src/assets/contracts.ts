/**
 * Asset request schemas and expected failures. An asset is identified by its
 * provider-qualified symbol alone; datasets produced for it are not part of
 * its identity. Response types live in `views.ts`.
 */

import { Schema } from "effect";

import {
  MarketDateSchema,
  MarketSymbolSchema,
  ProviderSchema,
} from "$/market-data/schemas";
import { isNotFutureDate } from "$/schema";

/** An asset's identity, such as `AAPL.US` or `BRK-B.US`, kept as given. */
export const AssetSymbolSchema = MarketSymbolSchema;

/** The earliest date its downloads request. Not in the future. */
const BackfillStartDateSchema = MarketDateSchema.check(
  isNotFutureDate("The start date must not be in the future"),
);

/**
 * HTTP input for creating an asset. Omitted `enabled` means enabled. Creating
 * an asset downloads nothing and creates no portfolio.
 */
export const CreateAssetSchema = Schema.Struct({
  symbol: AssetSymbolSchema,
  provider: ProviderSchema,
  backfillStartDate: BackfillStartDateSchema,
  enabled: Schema.optionalKey(Schema.Boolean),
});

/**
 * HTTP input for changing an asset's settings. The symbol is its identity and
 * cannot change; omitted fields keep their values.
 */
export const UpdateAssetSchema = Schema.Struct({
  provider: Schema.optionalKey(ProviderSchema),
  backfillStartDate: Schema.optionalKey(BackfillStartDateSchema),
  enabled: Schema.optionalKey(Schema.Boolean),
});

/** Decoded input consumed by `AssetStore.create`. */
export type CreateAsset = typeof CreateAssetSchema.Type;

/** Decoded partial update consumed by `AssetStore.update`. */
export type UpdateAsset = typeof UpdateAssetSchema.Type;

export type * from "$/assets/views";

/**
 * Expected failure reading or changing assets: an unknown symbol, a symbol
 * that already exists, or a database outage. Mapped to HTTP by `runHttp`.
 */
export class AssetError extends Schema.TaggedError<AssetError>()("AssetError", {
  kind: Schema.Literals(["database", "not_found", "conflict"]),
  message: Schema.String,
}) {}
