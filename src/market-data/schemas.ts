import { Schema, SchemaGetter } from "effect";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9-]*(?:\.[A-Z0-9][A-Z0-9-]*)?$/u;

type DateRange = {
  readonly symbols: readonly string[];
  readonly from: string;
  readonly to: string;
};

export const isDateOnly = Schema.makeFilter<string>((value) => {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return "Expected a date in YYYY-MM-DD format";
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? true
    : "Expected a valid calendar date";
});

// Canonical YYYY-MM-DD strings sort in chronological order.
const validDateRange = Schema.makeFilter<DateRange>((input) =>
  input.from <= input.to
    ? true
    : { path: ["to"], issue: "The end date must not precede the start date" },
);

export const MarketDateSchema = Schema.String.check(isDateOnly).annotate({
  identifier: "MarketDate",
});

/** The canonical symbol format exposed by the market-data interface. */
export const MarketSymbolSchema = Schema.String.check(
  Schema.isPattern(SYMBOL_PATTERN, {
    message: "Expected a market symbol such as AAPL.US",
  }),
).annotate({ identifier: "MarketSymbol" });

const MarketSymbolsSchema = Schema.NonEmptyArray(MarketSymbolSchema).check(
  Schema.isMaxLength(20, { message: "At most 20 symbols can be requested" }),
  Schema.isUnique({ message: "Symbols must be unique" }),
);

const MarketSymbolsFromStringSchema = Schema.String.pipe(
  Schema.decodeTo(MarketSymbolsSchema, {
    decode: SchemaGetter.transform((value): readonly [string, ...string[]] => {
      const symbols = value
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase());
      return [symbols[0] ?? "", ...symbols.slice(1)];
    }),
    encode: SchemaGetter.transform((symbols) => symbols.join(",")),
  }),
);

/** The query-string representation accepted by the HTTP endpoint. */
export const MarketDataQuerySchema = Schema.Struct({
  symbols: MarketSymbolsFromStringSchema,
  from: MarketDateSchema,
  to: MarketDateSchema,
}).check(validDateRange);

/** The normalized request accepted by market-data adapters. */
export const MarketDataRequestSchema = Schema.Struct({
  symbols: MarketSymbolsSchema,
  from: MarketDateSchema,
  to: MarketDateSchema,
}).check(validDateRange);
export type MarketDataRequest = typeof MarketDataRequestSchema.Type;

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
export type EodEntries = typeof EodEntriesSchema.Type;

export const EodEntriesBySymbolSchema = Schema.Record(
  MarketSymbolSchema,
  EodEntriesSchema,
);

/** A request to freeze available raw runs into one processing attempt. */
export const CreateProcessingJobSchema = Schema.Struct({
  symbol: MarketSymbolSchema,
  mode: Schema.Literals(["merge", "rebuild"]),
  transformVersion: Schema.NonEmptyString,
});
export type CreateProcessingJobRequest = typeof CreateProcessingJobSchema.Type;

/** The processor's report after it writes the canonical Parquet object. */
export const CompleteProcessingJobSchema = Schema.Struct({
  outputEtag: Schema.NonEmptyString,
  completeThrough: Schema.optionalKey(MarketDateSchema),
});
export type CompleteProcessingJobRequest =
  typeof CompleteProcessingJobSchema.Type;

/** The processor's terminal failure report. */
export const FailProcessingJobSchema = Schema.Struct({
  message: Schema.NonEmptyString,
});
export type FailProcessingJobRequest = typeof FailProcessingJobSchema.Type;
export type EodEntriesBySymbol = typeof EodEntriesBySymbolSchema.Type;
