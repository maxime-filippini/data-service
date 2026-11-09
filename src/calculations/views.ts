// Calculations, runs and types as the API returns them. This file has no
// imports so the dashboard app can import its types directly.

/**
 * Type-specific JSON parameters carried between the app, Worker and engine.
 * The Worker treats their contents as opaque; the engine owns validation/defaults.
 */
export type CalculationParams = Readonly<Record<string, unknown>>;

/**
 * Engine-provided description used to populate type choices and parameter
 * help in the app. `paramsSchema` describes the Python params model; it is
 * metadata for the editor, while the engine remains responsible for validation.
 */
export interface CalculationTypeInfo {
  readonly name: string;
  readonly description: string;
  readonly takesPortfolio: boolean;
  /** JSON Schema of the type's params. */
  readonly paramsSchema: unknown;
  /** Output column names and their polars types. */
  readonly output: Record<string, string>;
}

/**
 * Result of executing a type for one portfolio, used in run history and engine
 * responses. `portfolioId` is null for a type executed without a portfolio.
 * A completed outcome counts rows produced, not necessarily rows persisted.
 */
export interface PortfolioOutcome {
  readonly portfolioId: string | null;
  readonly status: "completed" | "failed";
  readonly rowCount: number;
  readonly error: string | null;
}

/**
 * How a saved calculation run was requested, for history and diagnostics.
 */
export type RunTrigger = "schedule" | "manual";

/**
 * Persisted execution state: `partial` wrote results for only some portfolios;
 * `skipped` records a request that did not execute because another run was active.
 */
export type CalculationRunStatus = "running" | "completed" | "partial" | "failed" | "skipped";

/**
 * Read model of one saved calculation execution, returned in history/detail
 * responses. Result fields are nullable before an outcome is recorded. Saved
 * params describe this run even if the calculation's current params change.
 */
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

/**
 * Saved configuration as returned to clients, enriched with its latest run
 * and claimed schedule slot. Use for lists/forms; request schemas define which
 * fields callers may write. `enabled` controls scheduled runs, not manual runs.
 */
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
