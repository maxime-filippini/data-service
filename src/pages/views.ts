// What the app's pages load, as plain types. Like the other views files, this
// imports only types from other views files (relatively), so the SvelteKit app
// can typecheck it without the Workers runtime types.

import type { Calculation, CalculationRun } from "../calculations/views";
import type { ScheduleRun, ScheduleView } from "../market-data/schedule/views";
import type { IngestionRunView, RunPage, SymbolStatusView } from "../market-data/status/views";
import type { Portfolio, PortfolioSummary } from "../portfolios/views";

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

/** A calculation run with its calculation's name. */
export interface NamedCalculationRun extends CalculationRun {
  readonly calculationName: string;
}

export interface UpcomingCalculation {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly cron: string;
  /** When the hourly tick next starts it. */
  readonly nextRunAt: string;
}

/** The home page: how both pipelines are doing. */
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
 * What the app's pages load on the server. Reads only: changes go through the
 * app's JSON API (`/app-api`) from the browser. Each method rejects with a
 * `PageDataError` if the data can't be loaded.
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
