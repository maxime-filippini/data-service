/**
 * Calculation input schemas and prepared persistence values. Routes decode
 * requests here; operations validate meaning, then pass prepared values to the
 * store. Runtime-free response projections live in `views.ts`.
 */

import { Schema } from "effect";

import { isCronError, parseCron } from "$/calculations/cron";
import type {
  CalculationParams,
  PortfolioOutcome,
  RunTrigger,
} from "$/calculations/views";
import { MarketDateSchema } from "$/market-data/schemas";
import { PortfolioIdSchema } from "$/portfolios/contracts";

/**
 * The engine registry key selecting a Python calculation type, such as
 * `ex_ante_vol`. Used in saved and ad hoc requests; the engine checks existence.
 */
export const CalculationTypeNameSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
);

/** Most portfolios one calculation can run over. */
export const MAX_CALCULATION_PORTFOLIOS = 100;

/**
 * UUID identifying a saved calculation and its stable result-object key.
 * Use for calculation route params; it does not identify an individual run.
 */
export const CalculationIdSchema = Schema.String.check(Schema.isUUID());

/**
 * UUID identifying one execution of a saved calculation. Also used as that
 * run's Workflow instance ID; validate independently of its calculation ID.
 */
export const RunIdSchema = Schema.String.check(Schema.isUUID());

/**
 * Human-readable label for a saved calculation. Trimmed for storage; names
 * are presentation values, not registry keys or unique identifiers.
 */
const CalculationNameSchema = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
);

/**
 * UTC schedule accepted when configuring calculations. Syntax is checked
 * here; scheduling evaluates whole hours, so the minute field has no effect.
 */
export const CronSchema = Schema.Trim.check(
  Schema.isMaxLength(200),
  Schema.makeFilter((cron) => {
    const parsed = parseCron(cron);
    return isCronError(parsed) ? parsed.error : true;
  }),
);

/**
 * JSON object accepted at the HTTP edge before type-specific validation.
 * Only the Python engine can check its fields and fill in type defaults.
 */
const ParamsSchema = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Ordered selection of saved portfolios for a calculation. Checks duplicates
 * and size; existence and compatibility with the calculation type are checked later.
 */
const PortfolioIdsSchema = Schema.Array(PortfolioIdSchema).check(
  Schema.isMaxLength(MAX_CALCULATION_PORTFOLIOS),
  Schema.makeFilter(
    (ids) =>
      new Set(ids).size === ids.length || "Each portfolio can appear only once",
  ),
);

/**
 * HTTP input for saving a reusable calculation configuration. The route
 * validates this shape, then `createCalculation` checks the type, params and
 * portfolio selection with the engine before persisting anything.
 */
export const CreateCalculationSchema = Schema.Struct({
  name: CalculationNameSchema,
  type: CalculationTypeNameSchema,
  /** Checked by the engine. Defaults to `{}`. */
  params: Schema.optionalKey(ParamsSchema),
  /** Required for types that take a portfolio, empty otherwise. */
  portfolioIds: Schema.optionalKey(PortfolioIdsSchema),
  cron: CronSchema,
  /** Defaults to true. */
  enabled: Schema.optionalKey(Schema.Boolean),
});

/**
 * HTTP input for changing a saved calculation. Omitted fields stay unchanged.
 * The operation rejects a different type and validates changed params or
 * portfolio selections; this schema alone does not enforce those rules.
 */
export const UpdateCalculationSchema = Schema.Struct({
  name: Schema.optionalKey(CalculationNameSchema),
  /** Accepted so a whole calculation can be sent back, but it must not change. */
  type: Schema.optionalKey(CalculationTypeNameSchema),
  params: Schema.optionalKey(ParamsSchema),
  portfolioIds: Schema.optionalKey(PortfolioIdsSchema),
  cron: Schema.optionalKey(CronSchema),
  enabled: Schema.optionalKey(Schema.Boolean),
});

/**
 * HTTP input for executing an existing saved calculation. `asOf` is a data
 * cutoff, not a start time; the route defaults it to the previous UTC day.
 */
export const StartRunSchema = Schema.Struct({
  /** Defaults to the previous UTC day. */
  asOf: Schema.optionalKey(MarketDateSchema),
});

/**
 * Decoded create request passed to `createCalculation`. Optional fields still
 * need their application/engine defaults; use `NewCalculation` for storage.
 */
export type CreateCalculation = typeof CreateCalculationSchema.Type;

/**
 * Decoded edit request for `updateCalculation`, before its engine checks.
 * Use `CalculationPatch` when passing the checked changes to the store.
 */
export type UpdateCalculation = typeof UpdateCalculationSchema.Type;

export type * from "$/calculations/views";

export type { CalculationRunStatus as RunStatus } from "$/calculations/views";

/**
 * Fully prepared record accepted by `Calculations.create`. The configuration
 * operation has supplied defaults and checked params with the engine; storage
 * still checks portfolio existence and saves their order atomically.
 */
export interface NewCalculation {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly params: CalculationParams;
  readonly portfolioIds: readonly string[];
  readonly cron: string;
  readonly enabled: boolean;
}

/**
 * Checked changes accepted by `Calculations.update`. Omitted fields are kept;
 * identity and type cannot be changed. HTTP callers start with `UpdateCalculation`.
 */
export type CalculationPatch = Partial<Omit<NewCalculation, "id" | "type">>;

/**
 * Execution record submitted to `Calculations.startRun` before launching its
 * Workflow. Captures params and the data cutoff; portfolio selections, holdings
 * and market-data versions are not frozen in this record.
 */
export interface NewRun {
  readonly runId: string;
  readonly calculationId: string;
  readonly trigger: RunTrigger;
  readonly asOf: string;
  readonly params: CalculationParams;
  readonly createdAt: string;
}

/**
 * Terminal outcome passed to `Calculations.finishRun` after execution. Records
 * what was written and each portfolio's outcome; `partial` means some portfolios
 * failed. An expected failed calculation is a value here, not an Effect failure.
 */
export interface FinishedRun {
  readonly status: "completed" | "partial" | "failed";
  readonly error: string | null;
  readonly portfolios: readonly PortfolioOutcome[];
  readonly rowCount: number;
  readonly outputEtag: string | null;
}

/**
 * Expected persistence, configuration or Workflow-launch failure reported by
 * calculation operations. HTTP mapping uses `kind`; per-portfolio execution
 * failures instead belong in `PortfolioOutcome`/`FinishedRun`.
 */
export class CalculationError extends Schema.TaggedError<CalculationError>()(
  "CalculationError",
  {
    /**
     * `invalid`: the calculation doesn't fit its type or names missing
     * portfolios. `workflow`: a run's Workflow could not be started.
     */
    kind: Schema.Literals(["database", "not_found", "invalid", "workflow"]),
    message: Schema.String,
    /** The portfolios that don't exist, for `invalid`. */
    portfolioIds: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {}

/** A calculation's results, in the processed bucket. */
export const calculationOutputKey = (calculationId: string) =>
  `calculation=${calculationId}/data.parquet`;
