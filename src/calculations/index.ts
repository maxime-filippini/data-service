import { Context, type Effect, Schema } from "effect";

import { CalculationTypeNameSchema } from "$/calculations/ad-hoc";
import { isCronError, parseCron } from "$/calculations/cron";
import type { CalculationParams, PortfolioOutcome } from "$/calculations/engine";
import { MarketDateSchema } from "$/market-data/schemas";
import { PortfolioIdSchema } from "$/portfolios";

/** Most portfolios one calculation can run over. */
export const MAX_CALCULATION_PORTFOLIOS = 100;

export const CalculationIdSchema = Schema.String.check(Schema.isUUID());
export const RunIdSchema = Schema.String.check(Schema.isUUID());

const CalculationNameSchema = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200));

export const CronSchema = Schema.Trim.check(
  Schema.isMaxLength(200),
  Schema.makeFilter((cron) => {
    const parsed = parseCron(cron);
    return isCronError(parsed) ? parsed.error : true;
  }),
);

const ParamsSchema = Schema.Record(Schema.String, Schema.Unknown);

/** Portfolio IDs, each once. Order is kept. */
const PortfolioIdsSchema = Schema.Array(PortfolioIdSchema).check(
  Schema.isMaxLength(MAX_CALCULATION_PORTFOLIOS),
  Schema.makeFilter((ids) => new Set(ids).size === ids.length || "Each portfolio can appear only once"),
);

/** The body of `POST /calculations`. */
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
export type CreateCalculation = typeof CreateCalculationSchema.Type;

/** The body of `PATCH /calculations/:id`. Omitted fields are kept. */
export const UpdateCalculationSchema = Schema.Struct({
  name: Schema.optionalKey(CalculationNameSchema),
  /** Accepted so a whole calculation can be sent back, but it must not change. */
  type: Schema.optionalKey(CalculationTypeNameSchema),
  params: Schema.optionalKey(ParamsSchema),
  portfolioIds: Schema.optionalKey(PortfolioIdsSchema),
  cron: Schema.optionalKey(CronSchema),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type UpdateCalculation = typeof UpdateCalculationSchema.Type;

/** The body of `POST /calculations/:id/runs`. */
export const StartRunSchema = Schema.Struct({
  /** Defaults to the previous UTC day. */
  asOf: Schema.optionalKey(MarketDateSchema),
});

export type RunTrigger = "schedule" | "manual";
export type RunStatus = "running" | "completed" | "partial" | "failed" | "skipped";

export interface CalculationRun {
  readonly runId: string;
  readonly calculationId: string;
  readonly trigger: RunTrigger;
  readonly asOf: string;
  /** The params the run used. */
  readonly params: CalculationParams;
  readonly status: RunStatus;
  /** Each portfolio's outcome, once the run has finished. */
  readonly portfolios: readonly PortfolioOutcome[] | null;
  readonly rowCount: number | null;
  readonly outputEtag: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface Calculation {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly params: CalculationParams;
  /** In the order they run. */
  readonly portfolioIds: readonly string[];
  readonly cron: string;
  readonly enabled: boolean;
  /** Where the results are in the processed bucket. */
  readonly outputKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The latest cron slot the schedule started a run for. */
  readonly lastScheduledSlot: string | null;
  readonly lastRun: CalculationRun | null;
}

/** A calculation's results, in the processed bucket. */
export const calculationOutputKey = (calculationId: string) => `calculation=${calculationId}/data.parquet`;

export class CalculationError extends Schema.TaggedError<CalculationError>()("CalculationError", {
  /**
   * `invalid`: the calculation doesn't fit its type or names missing
   * portfolios. `workflow`: a run's Workflow could not be started.
   */
  kind: Schema.Literals(["database", "not_found", "invalid", "workflow"]),
  message: Schema.String,
  /** The portfolios that don't exist, for `invalid`. */
  portfolioIds: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

/** What the store saves for a new calculation, after the engine has checked it. */
export interface NewCalculation {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly params: CalculationParams;
  readonly portfolioIds: readonly string[];
  readonly cron: string;
  readonly enabled: boolean;
}

export type CalculationPatch = Partial<Omit<NewCalculation, "id" | "type">>;

export interface NewRun {
  readonly runId: string;
  readonly calculationId: string;
  readonly trigger: RunTrigger;
  readonly asOf: string;
  readonly params: CalculationParams;
  readonly createdAt: string;
}

export interface FinishedRun {
  readonly status: "completed" | "partial" | "failed";
  readonly error: string | null;
  readonly portfolios: readonly PortfolioOutcome[];
  readonly rowCount: number;
  readonly outputEtag: string | null;
}

/**
 * Saved calculations and their runs. A calculation has at most one `running`
 * run; a run started meanwhile is recorded as `skipped`.
 */
export class Calculations extends Context.Service<
  Calculations,
  {
    /** Every calculation, by name, with its latest run. */
    readonly list: () => Effect.Effect<readonly Calculation[], CalculationError>;
    readonly get: (id: string) => Effect.Effect<Calculation, CalculationError>;
    /** Fails with `invalid` if a portfolio doesn't exist. */
    readonly create: (calculation: NewCalculation, now: string) => Effect.Effect<Calculation, CalculationError>;
    readonly update: (id: string, patch: CalculationPatch, now: string) => Effect.Effect<Calculation, CalculationError>;
    /** Delete a calculation and its runs. Its results stay in R2. */
    readonly remove: (id: string) => Effect.Effect<void, CalculationError>;
    /**
     * Record that the schedule is starting a run for a cron slot. False if
     * that slot or a later one was already recorded, so a slot runs once.
     */
    readonly claimSlot: (id: string, slot: string) => Effect.Effect<boolean, CalculationError>;

    /**
     * Record a new run as `running`, or as `skipped` if the calculation already
     * has one running. Returns the status it got.
     */
    readonly startRun: (run: NewRun) => Effect.Effect<"running" | "skipped", CalculationError>;
    /** Save a finished run's result. */
    readonly finishRun: (runId: string, result: FinishedRun, at: string) => Effect.Effect<void, CalculationError>;
    /** Fail a run if it's still running. */
    readonly failRun: (runId: string, error: string, at: string) => Effect.Effect<void, CalculationError>;
    /** Runs still `running`, of one calculation or of all. */
    readonly runningRuns: (calculationId?: string) => Effect.Effect<readonly CalculationRun[], CalculationError>;
    /** A calculation's runs, newest first. */
    readonly listRuns: (
      calculationId: string,
      limit: number,
    ) => Effect.Effect<readonly CalculationRun[], CalculationError>;
    readonly getRun: (runId: string) => Effect.Effect<CalculationRun, CalculationError>;
  }
>()("data-service/Calculations") {}
