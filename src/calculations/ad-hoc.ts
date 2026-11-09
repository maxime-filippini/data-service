import { Effect, Schema } from "effect";

import { CalculationTypeNameSchema } from "$/calculations/contracts";
import { type AdHocPortfolio, Engine } from "$/calculations/engine";
import { previousDay } from "$/datetime";
import { MarketDateSchema } from "$/market-data/schemas";
import {
  HoldingsSchema,
  PortfolioError,
  PortfolioIdSchema,
} from "$/portfolios/contracts";
import { Portfolios } from "$/portfolios/store";

/** Maximum heterogeneous portfolios evaluated in one synchronous request. */
export const MAX_AD_HOC_PORTFOLIOS = 100;

/** One saved portfolio reference or a complete inline holdings set. */
const AdHocPortfolioSchema = Schema.Union([
  Schema.Struct({ portfolioId: PortfolioIdSchema }),
  Schema.Struct({ holdings: HoldingsSchema }),
]);

/**
 * One-off calculation input. Use either `portfolio` for a single result or
 * `portfolios` for heterogeneous selections. Independent portfolio calculations
 * include `portfolio_index` in batch rows; aggregate types own their row shape.
 * The Worker resolves saved references and validates tracking before engine I/O.
 */
export const AdHocCalculationSchema = Schema.Struct({
  type: CalculationTypeNameSchema,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  /** Calculation date: holdings selection and market-data upper cutoff. */
  asOf: Schema.optionalKey(MarketDateSchema),
  portfolio: Schema.optionalKey(AdHocPortfolioSchema),
  portfolios: Schema.optionalKey(
    Schema.Array(AdHocPortfolioSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_AD_HOC_PORTFOLIOS),
    ),
  ),
}).check(
  Schema.makeFilter((input) =>
    input.portfolio !== undefined && input.portfolios !== undefined
      ? "Supply either portfolio or portfolios, not both"
      : true,
  ),
);

/**
 * Decoded one-off request consumed by `calculateAdHoc`. Still needs date/param
 * defaults and saved-portfolio resolution; `CalculateRequest` is the prepared
 * wire payload sent to Python.
 */
export type AdHocCalculation = typeof AdHocCalculationSchema.Type;

/** Resolve one selection without mutating saved holdings or creating a portfolio. */
const resolvePortfolio = Effect.fn("Calculations.resolvePortfolio")(function* (
  input: typeof AdHocPortfolioSchema.Type,
  asOf: string,
) {
  const portfolios = yield* Portfolios;
  if ("portfolioId" in input) {
    const portfolio = yield* portfolios.forEngine(input.portfolioId, asOf);
    if (portfolio.snapshots.length === 0) {
      return yield* Effect.fail(
        new PortfolioError({
          kind: "no_holdings",
          message: `The portfolio has no snapshot on or before ${asOf}`,
        }),
      );
    }
    return portfolio;
  }
  yield* portfolios.requireTracked(
    input.holdings.map((holding) => holding.symbol),
  );
  return { holdings: input.holdings } satisfies AdHocPortfolio;
});

/**
 * Resolve all selections before one engine call. Batches retain request order,
 * including duplicate saved IDs and multiple inline holdings sets. The engine
 * returns JSON or Arrow; no calculation, run or result object is persisted.
 */
export const calculateAdHoc = Effect.fn("Calculations.calculateAdHoc")(
  function* (input: AdHocCalculation, now: Date, accept?: string) {
    const asOf = input.asOf ?? previousDay(now);
    const portfolio =
      input.portfolio === undefined
        ? undefined
        : yield* resolvePortfolio(input.portfolio, asOf);
    const portfolios =
      input.portfolios === undefined
        ? undefined
        : yield* Effect.forEach(input.portfolios, (selection, index) =>
            resolvePortfolio(selection, asOf).pipe(
              Effect.mapError(
                (error) =>
                  new PortfolioError({
                    kind: error.kind,
                    message: `Portfolio at index ${index}: ${error.message}`,
                    ...(error.symbols === undefined
                      ? {}
                      : { symbols: error.symbols }),
                    ...(error.calculations === undefined
                      ? {}
                      : { calculations: error.calculations }),
                  }),
              ),
            ),
          );
    const engine = yield* Engine;
    return yield* engine.calculate(
      {
        type: input.type,
        params: input.params ?? {},
        asOf,
        ...(portfolio === undefined ? {} : { portfolio }),
        ...(portfolios === undefined ? {} : { portfolios }),
      },
      accept,
    );
  },
);
