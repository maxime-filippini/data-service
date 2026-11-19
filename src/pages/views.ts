// What the app's pages load, as plain types. Like the other views files, this
// imports only types from other views files (relatively), so the SvelteKit app
// can typecheck it without the Workers runtime types.

import type { Asset } from "../assets/views";
import type { PublicationView } from "../datasets/views";
import type { Portfolio, PortfolioSummary } from "../portfolios/views";
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "../workflows/runs/views";
import type {
  WorkflowAssignment,
  WorkflowDefault,
  WorkflowInspection,
  WorkflowSummary,
} from "../workflows/views";

/** Authenticated Access user shown in the app header and returned by `/app-api/me`. */
export interface DashboardUser {
  readonly email: string;
}

/**
 * Combined read model for the home page: asset, portfolio, workflow, run and
 * published-dataset summaries. Assemble through `PageData.home`; it is a
 * dashboard projection, not a transactionally consistent snapshot across tables.
 */
export interface HomeData {
  readonly assets: {
    readonly total: number;
    readonly enabled: number;
  };
  readonly portfolioCount: number;
  readonly workflows: {
    readonly total: number;
    readonly enabled: number;
    readonly definitions: readonly WorkflowSummary[];
  };
  /** Latest workflow runs, newest first. */
  readonly recentRuns: readonly WorkflowRunSummary[];
  readonly publications: {
    readonly total: number;
    /** Most recently published datasets, newest first. */
    readonly recent: readonly PublicationView[];
  };
}

/**
 * Promise-based, read-only interface used by SvelteKit server loads. Hides
 * Effect and Cloudflare wiring from pages; browser mutations use `/app-api`.
 * Each async method rejects with `PageDataError` on an expected read failure.
 */
export interface PageData {
  readonly home: () => Promise<HomeData>;
  readonly assets: () => Promise<readonly Asset[]>;
  /**
   * An asset, the definitions assigned to it, its latest workflow runs
   * (newest first) and its published datasets. 404 for an unknown symbol.
   */
  readonly asset: (symbol: string) => Promise<{
    readonly asset: Asset;
    readonly assignments: readonly WorkflowAssignment[];
    readonly runs: readonly WorkflowRunSummary[];
    readonly publications: readonly PublicationView[];
  }>;
  readonly portfolios: () => Promise<readonly PortfolioSummary[]>;
  /** 404 for an unknown ID. */
  readonly portfolio: (id: string) => Promise<Portfolio>;
  /**
   * Dated holdings, workflow assignments, latest runs and published datasets
   * for a portfolio. 404 for an unknown ID.
   */
  readonly portfolioDetail: (id: string) => Promise<{
    readonly portfolio: Portfolio;
    readonly assignments: readonly WorkflowAssignment[];
    readonly runs: readonly WorkflowRunSummary[];
    readonly publications: readonly PublicationView[];
  }>;
  readonly workflows: () => Promise<readonly WorkflowSummary[]>;
  /** The default workflows of each subject kind. */
  readonly workflowDefaults: () => Promise<readonly WorkflowDefault[]>;
  /**
   * A definition's ordered steps with their parameters and reference
   * connections, its assignments, whether new subjects of its scope get it
   * by default, and its latest runs, newest first. 404 for an unknown ID.
   */
  readonly workflow: (id: string) => Promise<{
    readonly inspection: WorkflowInspection;
    readonly assignments: readonly WorkflowAssignment[];
    readonly isDefault: boolean;
    readonly runs: readonly WorkflowRunSummary[];
  }>;
  /**
   * Workflow runs, newest first, filtered by status, trigger and asset
   * symbol. Unknown statuses and triggers are ignored.
   */
  readonly workflowRuns: (filter: {
    readonly status?: string;
    readonly trigger?: string;
    readonly symbol?: string;
  }) => Promise<readonly WorkflowRunSummary[]>;
  /** A run with its step outcomes. 404 for an unknown ID. */
  readonly workflowRun: (id: string) => Promise<WorkflowRunDetail>;
  /** Every current published dataset across assets and portfolios. */
  readonly publications: () => Promise<readonly PublicationView[]>;
}
