/**
 * Typed Drizzle mirrors of the D1 tables the ported adapters query. The SQL
 * files in `migrations/` stay the source of truth: they own CHECK
 * constraints, partial indexes, foreign keys and backfills, and
 * `wrangler d1 migrations` applies them. These definitions only give queries
 * typed columns and rows. `test/db-schema.test.ts` checks every table here
 * against the migrated database, so a column that is renamed, retyped,
 * dropped or made nullable in a migration fails the tests until it is
 * mirrored here.
 *
 * Add a table when an adapter is ported. Declare every column of it, so the
 * check also catches columns a migration adds.
 */

import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/** `INTEGER ... CHECK (x IN (0, 1))`, read and written as a boolean. */
const flag = (name: string) => integer(name, { mode: "boolean" });

/** The subject kinds; the CHECK lists in the migrations must match. */
const subjectKind = (name: string) =>
  text(name, { enum: ["asset", "portfolio"] });

export const assets = sqliteTable("assets", {
  symbol: text("symbol").primaryKey(),
  provider: text("provider").notNull(),
  backfillStartDate: text("backfill_start_date").notNull(),
  enabled: flag("enabled").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const portfolios = sqliteTable("portfolios", {
  portfolioId: text("portfolio_id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** Set only on a single-asset portfolio; unique where not null. */
  assetSymbol: text("asset_symbol"),
});

/** Positions in workflow assets. */
export const portfolioAssetHoldings = sqliteTable(
  "portfolio_asset_holdings",
  {
    portfolioId: text("portfolio_id").notNull(),
    holdingsDate: text("holdings_date").notNull(),
    symbol: text("symbol").notNull(),
    weight: real("weight").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.portfolioId, table.holdingsDate, table.symbol],
    }),
  ],
);

/** Legacy registry positions, always in the `prices_eod` dataset. */
export const portfolioHoldings = sqliteTable(
  "portfolio_holdings",
  {
    portfolioId: text("portfolio_id").notNull(),
    holdingsDate: text("holdings_date").notNull(),
    dataset: text("dataset", { enum: ["prices_eod"] }).notNull(),
    symbol: text("symbol").notNull(),
    weight: real("weight").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.portfolioId, table.holdingsDate, table.symbol],
    }),
  ],
);

export const workflowAssignments = sqliteTable(
  "workflow_assignments",
  {
    workflowId: text("workflow_id").notNull(),
    subjectKind: subjectKind("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    enabled: flag("enabled").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workflowId, table.subjectKind, table.subjectId],
    }),
  ],
);

export const workflowDefaults = sqliteTable(
  "workflow_defaults",
  {
    subjectKind: subjectKind("subject_kind").notNull(),
    workflowId: text("workflow_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subjectKind, table.workflowId] })],
);

/** The statuses `workflow_runs_one_active` treats as active. */
export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting"] as const;

export const workflowRuns = sqliteTable("workflow_runs", {
  runId: text("run_id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  workflowName: text("workflow_name").notNull(),
  subjectKind: subjectKind("subject_kind").notNull(),
  subjectId: text("subject_id").notNull(),
  processingDate: text("processing_date").notNull(),
  trigger: text("trigger", { enum: ["manual", "schedule"] }).notNull(),
  rerunOf: text("rerun_of"),
  status: text("status", {
    enum: [...ACTIVE_RUN_STATUSES, "completed", "failed", "skipped"],
  }).notNull(),
  error: text("error"),
  /** The ordered step specs, as JSON; decoded by the runs adapter. */
  stepsJson: text("steps_json").notNull(),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  scheduledFor: text("scheduled_for"),
});
