// What the app's pages load, as plain types. Like the other views files, this
// imports only types from other views files (relatively), so the SvelteKit app
// can typecheck it without the Workers runtime types.

import type { Calculation, CalculationRun } from "../calculations/views";
import type { ScheduleRun, ScheduleView } from "../market-data/schedule/views";
import type { IngestionRunView, RunPage, SymbolStatusView } from "../market-data/status/views";
import type { Portfolio, PortfolioSummary } from "../portfolios/views";

/**
 * Home-page summary of tracked symbols and their latest pipeline outcomes.
 * Counts describe symbols, not the total number of failed historical runs/jobs.
 */
export interface SymbolCounts {
  readonly total: number;
  /** On the daily schedule. */
  readonly scheduled: number;
  /** Whose latest download failed. */
  readonly failedDownloads: number;
  /** Whose latest Parquet rebuild failed. */
  readonly failedRebuilds: number;
  readonly neverDownloaded: number;
}

/**
 * Calculation-run read model enriched with a display name for mixed home-page
 * history. The name comes from the current calculation, not a run-time snapshot.
 */
export interface NamedCalculationRun extends CalculationRun {
  readonly calculationName: string;
}

/**
 * Enabled calculation paired with its next matching hourly slot for display.
 * This is a schedule preview, not a reserved run or a Workflow instance.
 */
export interface UpcomingCalculation {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly cron: string;
  /** When the hourly tick next starts it. */
  readonly nextRunAt: string;
}

/**
 * Combined read model for the home page: pipeline summaries and bounded
 * recent/upcoming lists. Assemble through `PageData.home`; it is a dashboard
 * projection, not a transactionally consistent snapshot across every table.
 */
export interface HomeData {
  readonly symbols: SymbolCounts;
  readonly schedule: ScheduleView;
  /** The schedule's latest runs, newest first. */
  readonly scheduleRuns: readonly ScheduleRun[];
  /** The latest failed downloads, newest first. */
  readonly failedRuns: readonly IngestionRunView[];
  readonly portfolioCount: number;
  readonly calculations: {
    readonly total: number;
    readonly enabled: number;
    /** Each calculation's latest run, newest first. */
    readonly latestRuns: readonly NamedCalculationRun[];
    /** Enabled calculations by when they next run. */
    readonly upcoming: readonly UpcomingCalculation[];
  };
}

/**
 * Promise-based, read-only interface used by SvelteKit server loads. Hides
 * Effect and Cloudflare wiring from pages; browser mutations use `/app-api`.
 * Each async method rejects with `PageDataError` on an expected read failure.
 */
export interface PageData {
  /** The first page of ingestion runs, filtered by symbol and status. Unknown statuses are ignored. */
  readonly runs: (filter: { readonly symbol?: string; readonly status?: string }) => Promise<RunPage>;
  readonly symbols: () => Promise<readonly SymbolStatusView[]>;
  /** The registry form's choices: the providers each dataset can use. */
  readonly options: () => { readonly datasetProviders: Readonly<Record<string, readonly string[]>> };
  readonly schedule: () => Promise<ScheduleView>;
  /** The schedule's latest runs, newest first. */
  readonly scheduleRuns: (limit?: number) => Promise<readonly ScheduleRun[]>;
  readonly portfolios: () => Promise<readonly PortfolioSummary[]>;
  /** 404 for an unknown ID. */
  readonly portfolio: (id: string) => Promise<Portfolio>;
  readonly calculations: () => Promise<readonly Calculation[]>;
  /** A calculation and its latest runs, newest first. 404 for an unknown ID. */
  readonly calculation: (
    id: string,
    runLimit?: number,
  ) => Promise<{ readonly calculation: Calculation; readonly runs: readonly CalculationRun[] }>;
  readonly home: () => Promise<HomeData>;
}
