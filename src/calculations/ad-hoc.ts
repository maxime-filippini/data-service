import { Effect, Schema } from "effect";

import { CalculationTypeNameSchema } from "$/calculations/contracts";
import { type AdHocPortfolio, Engine } from "$/calculations/engine";
import { previousDay } from "$/market-data/ingestion-queue";
import { MarketDateSchema } from "$/market-data/schemas";
import { HoldingsSchema, PortfolioError, PortfolioIdSchema } from "$/portfolios/contracts";
import { Portfolios } from "$/portfolios/store";

/**
 * HTTP input for a one-off calculation without a saved configuration or R2
 * result write. A portfolio reference is resolved by the Worker; inline holdings
 * are checked for tracked symbols before being sent to the engine.
 */
export const AdHocCalculationSchema = Schema.Struct({
  type: CalculationTypeNameSchema,
  /** Checked by the engine. Defaults to `{}`. */
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  /** Defaults to the previous UTC day. */
  asOf: Schema.optionalKey(MarketDateSchema),
  /** A saved portfolio, or holdings held at all times. Left out for types that don't take one. */
  portfolio: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ portfolioId: PortfolioIdSchema }),
      Schema.Struct({ holdings: HoldingsSchema }),
    ]),
  ),
});

/**
 * Decoded one-off request consumed by `calculateAdHoc`. Still needs date/param
 * defaults and saved-portfolio resolution; `CalculateRequest` is the prepared
 * wire payload sent to Python.
 */
export type AdHocCalculation = typeof AdHocCalculationSchema.Type;

/**
 * Run an ad hoc calculation. A saved portfolio sends its snapshots up to the
 * as-of date; plain holdings are checked to be tracked first. Returns the
 * engine's response (JSON or Arrow, by `accept`).
 */
export const calculateAdHoc = Effect.fn("Calculations.calculateAdHoc")(function* (
  input: AdHocCalculation,
  now: Date,
  accept?: string,
) {
  const asOf = input.asOf ?? previousDay(now);
  const portfolios = yield* Portfolios;

  let portfolio: AdHocPortfolio | undefined;
  if (input.portfolio !== undefined && "portfolioId" in input.portfolio) {
    portfolio = yield* portfolios.forEngine(input.portfolio.portfolioId, asOf);
    if (portfolio.snapshots.length === 0) {
      return yield* Effect.fail(
        new PortfolioError({ kind: "no_holdings", message: `The portfolio has no snapshot on or before ${asOf}` }),
      );
    }
  } else if (input.portfolio !== undefined) {
    yield* portfolios.requireTracked(input.portfolio.holdings.map((holding) => holding.symbol));
    portfolio = { holdings: input.portfolio.holdings };
  }

  const engine = yield* Engine;
  return yield* engine.calculate(
    { type: input.type, params: input.params ?? {}, asOf, ...(portfolio === undefined ? {} : { portfolio }) },
    accept,
  );
});
