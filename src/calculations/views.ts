// Calculations, runs and types as the API returns them. This file has no
// imports so the dashboard app can import its types directly.

export type CalculationParams = Readonly<Record<string, unknown>>;

/** A calculation type, as `GET /types` describes it. */
export interface CalculationTypeInfo {
  readonly name: string;
  readonly description: string;
  readonly takesPortfolio: boolean;
  /** JSON Schema of the type's params. */
  readonly paramsSchema: unknown;
  /** Output column names and their polars types. */
  readonly output: Record<string, string>;
}

export interface PortfolioOutcome {
  readonly portfolioId: string | null;
  readonly status: "completed" | "failed";
  readonly rowCount: number;
  readonly error: string | null;
}

export type RunTrigger = "schedule" | "manual";
export type CalculationRunStatus = "running" | "completed" | "partial" | "failed" | "skipped";

export interface CalculationRun {
  readonly runId: string;
  readonly calculationId: string;
  readonly trigger: RunTrigger;
  readonly asOf: string;
  /** The params the run used. */
  readonly params: CalculationParams;
  readonly status: CalculationRunStatus;
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
