import { Schema } from "effect";

import { utcDay } from "$/datetime";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9-]*(?:\.[A-Z0-9][A-Z0-9-]*)?$/u;

const isDateOnly = Schema.makeFilter<string>((value) => {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return "Expected a date in YYYY-MM-DD format";
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && utcDay(date) === value
    ? true
    : "Expected a valid calendar date";
});

/**
 * Calendar-valid date-only string for market-data cutoffs and holdings dates.
 * Rejects normalized invalid dates; carries no time of day or exchange timezone.
 */
export const MarketDateSchema = Schema.String.check(isDateOnly).annotate({
  identifier: "MarketDate",
});

/** Path-safe identifier such as AAPL, AAPL.US, BRK-B.US or DGS10. */
export const MarketSymbolSchema = Schema.String.check(
  Schema.isPattern(SYMBOL_PATTERN, {
    message: "Expected an uppercase symbol such as AAPL.US",
  }),
).annotate({ identifier: "MarketSymbol" });

/** Datasets supported by the market-data adapters. */
export const DatasetSchema = Schema.Literals(["prices_eod"]);

/** Providers with a market-data download adapter. */
export const ProviderSchema = Schema.Literals(["eodhd"]);

/**
 * One provider end-of-day price/volume row validated before storing the raw
 * run artifact. Its field names are mirrored by the Python normalization
 * operation; this schema checks values, not completeness of price history.
 */
export const EodEntrySchema = Schema.Struct({
  date: MarketDateSchema,
  open: Schema.Finite,
  close: Schema.Finite,
  high: Schema.Finite,
  low: Schema.Finite,
  adjusted_close: Schema.Finite,
  volume: Schema.Natural,
});

/**
 * Provider response decoder for a full-history snapshot. Empty arrays are
 * accepted and duplicate-date handling belongs to the processor rebuild.
 */
export const EodEntriesSchema = Schema.Array(EodEntrySchema);

/**
 * Inclusive market-data date bounds in `YYYY-MM-DD` form, used by provider
 * requests and raw-object provenance. This TypeScript interface does not
 * validate dates or their ordering; decode external dates with `MarketDateSchema`.
 */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/**
 * Supported dataset key selecting the raw/canonical storage layout and processor
 * schema. It describes a kind of data, not a particular symbol or downloaded file.
 */
export type Dataset = typeof DatasetSchema.Type;

/**
 * Registered provider key used to select an ingestion adapter. Compatibility
 * with a particular dataset is described by `datasetProviders`.
 */
export type Provider = typeof ProviderSchema.Type;

/**
 * Decoded end-of-day row consumed by provider/storage code. Prefer the smaller
 * `DatedEntry` interface when only the observation date is needed.
 */
export type EodEntry = typeof EodEntrySchema.Type;

/** The stable Parquet object that client apps read from the processed bucket. */
export const canonicalKey = (dataset: Dataset, symbol: string) =>
  `dataset=${dataset}/symbol=${symbol}/data.parquet`;
