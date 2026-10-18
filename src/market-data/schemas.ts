import { Schema } from "effect";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9-]*(?:\.[A-Z0-9][A-Z0-9-]*)?$/u;

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

const isDateOnly = Schema.makeFilter<string>((value) => {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return "Expected a date in YYYY-MM-DD format";
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? true
    : "Expected a valid calendar date";
});

export const MarketDateSchema = Schema.String.check(isDateOnly).annotate({
  identifier: "MarketDate",
});

/** Path-safe identifier such as AAPL, AAPL.US, BRK-B.US or DGS10. */
export const MarketSymbolSchema = Schema.String.check(
  Schema.isPattern(SYMBOL_PATTERN, {
    message: "Expected an uppercase symbol such as AAPL.US",
  }),
).annotate({ identifier: "MarketSymbol" });

/** Datasets the processor knows how to build. Each has its own Parquet schema. */
export const DatasetSchema = Schema.Literals(["prices_eod"]);
export type Dataset = typeof DatasetSchema.Type;

/** Providers with an ingestion adapter. */
export const ProviderSchema = Schema.Literals(["eodhd"]);
export type Provider = typeof ProviderSchema.Type;

/** Which providers can supply each dataset. */
export const datasetProviders: Record<Dataset, readonly Provider[]> = {
  prices_eod: ["eodhd"],
};

/** The stable Parquet object that client apps read from the processed bucket. */
export const canonicalKey = (dataset: Dataset, symbol: string) =>
  `dataset=${dataset}/symbol=${symbol}/data.parquet`;

export const EodEntrySchema = Schema.Struct({
  date: MarketDateSchema,
  open: Schema.Finite,
  close: Schema.Finite,
  high: Schema.Finite,
  low: Schema.Finite,
  adjusted_close: Schema.Finite,
  volume: Schema.Natural,
});
export type EodEntry = typeof EodEntrySchema.Type;

export const EodEntriesSchema = Schema.Array(EodEntrySchema);
