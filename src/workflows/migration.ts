import { Effect, Schema } from "effect";

import { SINGLE_ASSET_HOLDINGS_DATE } from "$/portfolios/contracts";
import { WorkflowIdSchema, type WorkflowSpec } from "$/workflows/contracts";
import {
  builtInStepTypes,
  makeStepTypes,
  type StepTypes,
} from "$/workflows/registry";
import { validateWorkflowSpec } from "$/workflows/validate";

/**
 * Deterministic UUID for the standard EOD prices download workflow seeded by
 * migration from legacy `tracked_symbols` and `download_schedule`.
 */
export const DEFAULT_PRICES_EOD_WORKFLOW_ID =
  "7f8b4e30-2c1a-4d6e-9b5a-100000000001";

/** Default display name for the standard EOD prices workflow. */
export const DEFAULT_PRICES_EOD_WORKFLOW_NAME = "Daily EOD prices";

/** Legacy dataset migrated into `assets` and the default download workflow. */
export const PRICES_EOD_DATASET = "prices_eod";

const REQUIRED_TABLES = [
  "tracked_symbols",
  "download_schedule",
  "portfolios",
  "portfolio_snapshots",
  "portfolio_holdings",
  "calculations",
  "calculation_portfolios",
  "calculation_runs",
  "ingestion_runs",
  "processing_jobs",
  "schedule_runs",
  "assets",
  "workflow_definitions",
  "workflow_defaults",
  "workflow_assignments",
  "workflow_runs",
  "dataset_publications",
  "portfolio_asset_holdings",
] as const;

const ACTIVE_WORKFLOW_RUN_STATUSES = `('queued', 'running', 'waiting')`;

/** Expected error while inspecting, applying, cutting over, or rolling back migration state. */
export class MigrationError extends Schema.TaggedError<MigrationError>()(
  "MigrationError",
  {
    kind: Schema.Literals(["database", "invalid", "precondition"]),
    message: Schema.String,
  },
) {}

/** Legacy `tracked_symbols` registration captured in inventory reports. */
export interface TrackedSymbolRecord {
  readonly dataset: string;
  readonly symbol: string;
  readonly provider: string;
  readonly backfillStartDate: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Existing custom `assets` row whose settings differ from `tracked_symbols`. */
export interface ConflictingAsset {
  readonly symbol: string;
  readonly tracked: {
    readonly provider: string;
    readonly backfillStartDate: string;
    readonly enabled: boolean;
  };
  readonly existing: {
    readonly provider: string;
    readonly backfillStartDate: string;
    readonly enabled: boolean;
  };
}

/** Legacy saved calculation whose arbitrary cron schedule is reported rather than translated. */
export interface UnsupportedCalculation {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly lastScheduledSlot: string | null;
  readonly reason: string;
}

/** User-created portfolio preserved during migration. */
export interface RealPortfolioSummary {
  readonly id: string;
  readonly name: string;
  readonly snapshotCount: number;
  readonly holdingsCount: number;
}

/** Reference counts checked before removing any generated single-asset portfolio. */
export interface PortfolioReferenceCounts {
  readonly calculationPortfolios: number;
  readonly calculationRuns: number;
  readonly workflowAssignments: number;
  readonly workflowRuns: number;
  readonly activeWorkflowRuns: number;
  readonly datasetPublications: number;
}

/** Positively identified generated single-asset portfolio and its disposition. */
export interface GeneratedSingleAssetPortfolio {
  readonly id: string;
  readonly name: string;
  readonly assetSymbol: string;
  readonly references: PortfolioReferenceCounts;
  readonly removable: boolean;
  readonly reason: string;
}

/** Portfolio with `asset_symbol` set that does not match the exact generated shape and is retained. */
export interface UnverifiedAssetPortfolio {
  readonly id: string;
  readonly name: string;
  readonly assetSymbol: string;
  readonly reason: string;
}

/** Counts of legacy and workflow operational tables preserved across migration. */
export interface RetainedDataCounts {
  readonly ingestionRuns: number;
  readonly processingJobs: number;
  readonly datasetPublications: number;
  readonly portfolioHoldings: number;
  readonly portfolioAssetHoldings: number;
  readonly scheduleRuns: number;
  readonly calculationRuns: number;
  readonly workflowRuns: number;
}

/** Complete read-only inventory and dry-run plan for migrating downloads to workflows. */
export interface MigrationInventoryReport {
  readonly dryRun: true;
  readonly downloadSchedule: {
    readonly hourUtc: number;
    readonly paused: boolean;
    readonly updatedAt: string;
  };
  readonly trackedSymbols: {
    readonly total: number;
    readonly pricesEodTotal: number;
    readonly pricesEodEnabled: number;
    readonly pricesEodDisabled: number;
    readonly unsupportedDatasets: readonly TrackedSymbolRecord[];
  };
  readonly assets: {
    readonly existingCount: number;
    readonly toCreate: readonly string[];
    readonly alreadyAligned: readonly string[];
    readonly conflicts: readonly ConflictingAsset[];
  };
  readonly workflow: {
    readonly workflowId: string;
    readonly name: string;
    readonly desiredScheduleHourUtc: number;
    readonly desiredEnabled: boolean;
    readonly definitionStatus:
      "missing" | "exists_matching" | "exists_modified";
    readonly defaultStatus: "missing" | "exists";
    readonly assignmentsToCreate: readonly string[];
    readonly existingAssignmentsEnabled: readonly string[];
    readonly existingAssignmentsDisabled: readonly string[];
  };
  readonly calculations: {
    readonly total: number;
    readonly unsupportedSchedules: readonly UnsupportedCalculation[];
  };
  readonly portfolios: {
    readonly total: number;
    readonly real: readonly RealPortfolioSummary[];
    readonly generatedSingleAssetRemovable: readonly GeneratedSingleAssetPortfolio[];
    readonly generatedSingleAssetRetained: readonly GeneratedSingleAssetPortfolio[];
    readonly unverifiedAssetPortfolios: readonly UnverifiedAssetPortfolio[];
  };
  readonly retainedData: RetainedDataCounts;
}

/** Outcome of one idempotent migration apply pass. */
export interface MigrationApplyReport {
  readonly dryRun: false;
  readonly appliedAt: string;
  readonly workflowId: string;
  readonly createdAssets: readonly string[];
  readonly skippedConflictingAssets: readonly ConflictingAsset[];
  readonly unsupportedTrackedSymbols: readonly TrackedSymbolRecord[];
  readonly createdWorkflowDefinition: boolean;
  readonly createdWorkflowDefault: boolean;
  readonly createdAssignments: readonly string[];
  readonly preservedDisabledAssignments: readonly string[];
  readonly removedSingleAssetPortfolios: readonly GeneratedSingleAssetPortfolio[];
  readonly retainedSingleAssetPortfolios: readonly GeneratedSingleAssetPortfolio[];
  readonly unverifiedAssetPortfolios: readonly UnverifiedAssetPortfolio[];
  readonly unsupportedCalculations: readonly UnsupportedCalculation[];
  readonly mutations: number;
  readonly inventoryAfter: MigrationInventoryReport;
}

/** Outcome of the explicit download cutover operation. */
export interface CutoverReport {
  readonly operation: "cutover";
  readonly performedAt: string;
  readonly workflowId: string;
  readonly workflowEnabled: boolean;
  readonly workflowScheduleHourUtc: number;
  readonly assignedAssetsCount: number;
  readonly enabledAssignmentsCount: number;
  readonly legacySchedulePausedBefore: boolean;
  readonly legacySchedulePausedAfter: boolean;
  readonly readyForWorkflowDispatchOn: boolean;
  readonly nextStep: string;
}

/** Outcome of the explicit download rollback operation. */
export interface RollbackReport {
  readonly operation: "rollback";
  readonly performedAt: string;
  readonly legacySchedulePausedBefore: boolean;
  readonly legacySchedulePausedAfter: boolean;
  readonly legacyScheduleHourUtc: number;
  readonly nextStep: string;
}

/** Optional overrides for migration timestamps and step registry validation. */
export interface MigrationOptions {
  readonly now?: string;
  readonly registry?: StepTypes;
}

/** Build the standard asset download workflow specification from the legacy schedule. */
export const defaultPricesEodWorkflowSpec = (schedule: {
  readonly hourUtc: number;
  readonly paused: boolean;
}): WorkflowSpec => ({
  name: DEFAULT_PRICES_EOD_WORKFLOW_NAME,
  scope: "asset",
  enabled: !schedule.paused,
  schedule: { hourUtc: schedule.hourUtc },
  steps: [
    {
      id: "download",
      type: "download-prices",
      params: {},
      inputs: {
        asset: { ref: "context.subject" },
        throughDate: { ref: "context.processingDate" },
      },
    },
    {
      id: "normalize",
      type: "normalize-prices",
      params: {},
      inputs: {
        raw: { ref: "steps.download.outputs.raw" },
      },
    },
    {
      id: "publish",
      type: "publish-dataset",
      params: { dataset: PRICES_EOD_DATASET },
      inputs: {
        data: { ref: "steps.normalize.outputs.prices" },
      },
    },
  ],
});

interface TrackedSymbolRow {
  readonly dataset: string;
  readonly symbol: string;
  readonly provider: string;
  readonly enabled: number;
  readonly backfill_start_date: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AssetRow {
  readonly symbol: string;
  readonly provider: string;
  readonly backfill_start_date: string;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ScheduleRow {
  readonly hour_utc: number;
  readonly paused: number;
  readonly updated_at: string;
}

interface DefinitionRow {
  readonly workflow_id: string;
  readonly name: string;
  readonly scope: "asset" | "portfolio";
  readonly enabled: number;
  readonly schedule_hour_utc: number;
  readonly steps_json: string;
}

interface AssignmentRow {
  readonly subject_id: string;
  readonly enabled: number;
}

interface CalculationRow {
  readonly calculation_id: string;
  readonly name: string;
  readonly type: string;
  readonly cron: string | null;
  readonly enabled: number;
  readonly last_scheduled_slot: string | null;
}

interface PortfolioRow {
  readonly portfolio_id: string;
  readonly name: string;
  readonly asset_symbol: string | null;
}

interface SnapshotRow {
  readonly portfolio_id: string;
  readonly holdings_date: string;
}

interface HoldingRow {
  readonly portfolio_id: string;
  readonly holdings_date: string;
  readonly symbol: string;
  readonly weight: number;
  readonly dataset: string | null;
  readonly source: "legacy" | "asset";
}

interface CountByPortfolioRow {
  readonly portfolio_id: string;
  readonly count: number;
}

interface WorkflowRunCountRow {
  readonly portfolio_id: string;
  readonly total: number;
  readonly active: number;
}

const defaultRegistry = () => makeStepTypes(builtInStepTypes);

const query = <A>(operation: () => Promise<A>, context: string) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new MigrationError({
        kind: "database",
        message: `${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const validateDefaultSpec = (spec: WorkflowSpec, registry: StepTypes) => {
  if (!Schema.is(WorkflowIdSchema)(DEFAULT_PRICES_EOD_WORKFLOW_ID)) {
    return Effect.fail(
      new MigrationError({
        kind: "invalid",
        message: `Default workflow ID ${DEFAULT_PRICES_EOD_WORKFLOW_ID} is not a valid UUID`,
      }),
    );
  }
  const issues = validateWorkflowSpec(spec, registry);
  if (issues.length > 0) {
    return Effect.fail(
      new MigrationError({
        kind: "invalid",
        message: `Default prices_eod workflow spec failed validation: ${issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      }),
    );
  }
  return Effect.void;
};

const ensureSchemaReady = (db: D1Database) =>
  Effect.gen(function* () {
    const { results } = yield* query(
      () =>
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all<{ name: string }>(),
      "Could not inspect database tables",
    );
    const present = new Set(results.map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    if (missing.length > 0) {
      return yield* new MigrationError({
        kind: "precondition",
        message: `Missing required schema tables (${missing.join(", ")}); apply migrations 0001-0014 before running workflow migration`,
      });
    }
    yield* query(
      () => db.prepare(`SELECT asset_symbol FROM portfolios LIMIT 1`).all(),
      "Missing portfolios.asset_symbol column from migration 0008",
    );
  });

const loadDownloadSchedule = (db: D1Database) =>
  query(
    () =>
      db
        .prepare(
          `SELECT hour_utc, paused, updated_at FROM download_schedule WHERE id = 1`,
        )
        .first<ScheduleRow>(),
    "Could not read download_schedule",
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.fail(
            new MigrationError({
              kind: "precondition",
              message:
                "The singleton download_schedule row (id = 1) is missing",
            }),
          )
        : Effect.succeed({
            hourUtc: row.hour_utc,
            paused: row.paused === 1,
            updatedAt: row.updated_at,
          }),
    ),
  );

const toTrackedSymbol = (row: TrackedSymbolRow): TrackedSymbolRecord => ({
  dataset: row.dataset,
  symbol: row.symbol,
  provider: row.provider,
  backfillStartDate: row.backfill_start_date,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const referenceReasons = (refs: PortfolioReferenceCounts): string[] => {
  const reasons: string[] = [];
  if (refs.calculationPortfolios > 0)
    reasons.push(
      `referenced by ${refs.calculationPortfolios} calculation_portfolios row(s)`,
    );
  if (refs.calculationRuns > 0)
    reasons.push(
      `referenced by ${refs.calculationRuns} calculation_runs record(s)`,
    );
  if (refs.workflowAssignments > 0)
    reasons.push(
      `referenced by ${refs.workflowAssignments} workflow_assignments row(s)`,
    );
  if (refs.workflowRuns > 0)
    reasons.push(
      refs.activeWorkflowRuns > 0
        ? `referenced by ${refs.workflowRuns} workflow_runs record(s) (${refs.activeWorkflowRuns} active)`
        : `referenced by ${refs.workflowRuns} workflow_runs record(s)`,
    );
  if (refs.datasetPublications > 0)
    reasons.push(
      `referenced by ${refs.datasetPublications} dataset_publications row(s)`,
    );
  return reasons;
};

const countTable = (db: D1Database, table: string) =>
  query(
    () =>
      db
        .prepare(`SELECT count(*) AS count FROM ${table}`)
        .first<{ count: number }>(),
    `Could not count rows in ${table}`,
  ).pipe(Effect.map((row) => row?.count ?? 0));

/**
 * Inspect legacy and workflow state without modifying the database. Produces
 * a deterministic dry-run report covering tracked symbols, assets, schedule,
 * workflow definition/default/assignments, unsupported calculation cron
 * schedules, generated vs real portfolios, and retained operational data.
 */
export const inventoryMigration = Effect.fn("WorkflowMigration.inventory")(
  function* (db: D1Database, options: MigrationOptions = {}) {
    yield* ensureSchemaReady(db);
    const registry = options.registry ?? defaultRegistry();
    const downloadSchedule = yield* loadDownloadSchedule(db);
    const desiredSpec = defaultPricesEodWorkflowSpec(downloadSchedule);
    yield* validateDefaultSpec(desiredSpec, registry);

    const [
      trackedResult,
      assetsResult,
      definitionRow,
      defaultRow,
      assignmentsResult,
      calculationsResult,
      portfoliosResult,
      snapshotsResult,
      holdingsResult,
      calcPortfolioRefsResult,
      calcRunRefsResult,
      workflowAssignmentRefsResult,
      workflowRunRefsResult,
      publicationRefsResult,
    ] = yield* Effect.all([
      query(
        () =>
          db
            .prepare(`SELECT * FROM tracked_symbols ORDER BY dataset, symbol`)
            .all<TrackedSymbolRow>(),
        "Could not read tracked_symbols",
      ),
      query(
        () =>
          db.prepare(`SELECT * FROM assets ORDER BY symbol`).all<AssetRow>(),
        "Could not read assets",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT workflow_id, name, scope, enabled, schedule_hour_utc, steps_json
               FROM workflow_definitions WHERE workflow_id = ?`,
            )
            .bind(DEFAULT_PRICES_EOD_WORKFLOW_ID)
            .first<DefinitionRow>(),
        "Could not read workflow_definitions",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT workflow_id FROM workflow_defaults
               WHERE subject_kind = 'asset' AND workflow_id = ?`,
            )
            .bind(DEFAULT_PRICES_EOD_WORKFLOW_ID)
            .first<{ workflow_id: string }>(),
        "Could not read workflow_defaults",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT subject_id, enabled FROM workflow_assignments
               WHERE workflow_id = ? AND subject_kind = 'asset'
               ORDER BY subject_id`,
            )
            .bind(DEFAULT_PRICES_EOD_WORKFLOW_ID)
            .all<AssignmentRow>(),
        "Could not read workflow_assignments",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT calculation_id, name, type, cron, enabled, last_scheduled_slot
               FROM calculations ORDER BY name, calculation_id`,
            )
            .all<CalculationRow>(),
        "Could not read calculations",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT portfolio_id, name, asset_symbol FROM portfolios ORDER BY name, portfolio_id`,
            )
            .all<PortfolioRow>(),
        "Could not read portfolios",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT portfolio_id, holdings_date FROM portfolio_snapshots ORDER BY portfolio_id, holdings_date`,
            )
            .all<SnapshotRow>(),
        "Could not read portfolio_snapshots",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT portfolio_id, holdings_date, symbol, weight, dataset, 'legacy' AS source
               FROM portfolio_holdings
               UNION ALL
               SELECT portfolio_id, holdings_date, symbol, weight, NULL AS dataset, 'asset' AS source
               FROM portfolio_asset_holdings
               ORDER BY portfolio_id, holdings_date, symbol`,
            )
            .all<HoldingRow>(),
        "Could not read portfolio holdings",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT portfolio_id, count(*) AS count
               FROM calculation_portfolios GROUP BY portfolio_id`,
            )
            .all<CountByPortfolioRow>(),
        "Could not read calculation_portfolios",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT j.value ->> '$.portfolioId' AS portfolio_id, count(DISTINCT r.run_id) AS count
               FROM calculation_runs r, json_each(r.portfolios_json) j
               WHERE r.portfolios_json IS NOT NULL
                 AND j.value ->> '$.portfolioId' IS NOT NULL
               GROUP BY j.value ->> '$.portfolioId'`,
            )
            .all<CountByPortfolioRow>(),
        "Could not read calculation_runs",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT subject_id AS portfolio_id, count(*) AS count
               FROM workflow_assignments
               WHERE subject_kind = 'portfolio'
               GROUP BY subject_id`,
            )
            .all<CountByPortfolioRow>(),
        "Could not read portfolio workflow_assignments",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT subject_id AS portfolio_id,
                      count(*) AS total,
                      sum(CASE WHEN status IN ${ACTIVE_WORKFLOW_RUN_STATUSES} THEN 1 ELSE 0 END) AS active
               FROM workflow_runs
               WHERE subject_kind = 'portfolio'
               GROUP BY subject_id`,
            )
            .all<WorkflowRunCountRow>(),
        "Could not read portfolio workflow_runs",
      ),
      query(
        () =>
          db
            .prepare(
              `SELECT subject_id AS portfolio_id, count(*) AS count
               FROM dataset_publications
               WHERE subject_kind = 'portfolio'
               GROUP BY subject_id`,
            )
            .all<CountByPortfolioRow>(),
        "Could not read portfolio dataset_publications",
      ),
    ]);

    const [
      ingestionRuns,
      processingJobs,
      datasetPublications,
      portfolioHoldings,
      portfolioAssetHoldings,
      scheduleRuns,
      calculationRuns,
      workflowRuns,
    ] = yield* Effect.all([
      countTable(db, "ingestion_runs"),
      countTable(db, "processing_jobs"),
      countTable(db, "dataset_publications"),
      countTable(db, "portfolio_holdings"),
      countTable(db, "portfolio_asset_holdings"),
      countTable(db, "schedule_runs"),
      countTable(db, "calculation_runs"),
      countTable(db, "workflow_runs"),
    ]);

    const tracked = trackedResult.results.map(toTrackedSymbol);
    const pricesEodTracked = tracked.filter(
      (row) => row.dataset === PRICES_EOD_DATASET,
    );
    const unsupportedDatasets = tracked.filter(
      (row) => row.dataset !== PRICES_EOD_DATASET,
    );

    const existingAssets = new Map(
      assetsResult.results.map((row) => [row.symbol, row]),
    );
    const toCreate: string[] = [];
    const alreadyAligned: string[] = [];
    const conflicts: ConflictingAsset[] = [];

    for (const row of pricesEodTracked) {
      const existing = existingAssets.get(row.symbol);
      if (existing === undefined) {
        toCreate.push(row.symbol);
        continue;
      }
      const existingEnabled = existing.enabled === 1;
      if (
        existing.provider === row.provider &&
        existing.backfill_start_date === row.backfillStartDate &&
        existingEnabled === row.enabled
      ) {
        alreadyAligned.push(row.symbol);
      } else {
        conflicts.push({
          symbol: row.symbol,
          tracked: {
            provider: row.provider,
            backfillStartDate: row.backfillStartDate,
            enabled: row.enabled,
          },
          existing: {
            provider: existing.provider,
            backfillStartDate: existing.backfill_start_date,
            enabled: existingEnabled,
          },
        });
      }
    }

    const desiredStepsJson = JSON.stringify(desiredSpec.steps);
    const definitionStatus =
      definitionRow === null
        ? ("missing" as const)
        : definitionRow.name === desiredSpec.name &&
            definitionRow.scope === desiredSpec.scope &&
            (definitionRow.enabled === 1) === desiredSpec.enabled &&
            definitionRow.schedule_hour_utc === desiredSpec.schedule.hourUtc &&
            definitionRow.steps_json === desiredStepsJson
          ? ("exists_matching" as const)
          : ("exists_modified" as const);

    const assignmentsBySymbol = new Map(
      assignmentsResult.results.map((row) => [
        row.subject_id,
        row.enabled === 1,
      ]),
    );
    const assignmentsToCreate: string[] = [];
    const existingAssignmentsEnabled: string[] = [];
    const existingAssignmentsDisabled: string[] = [];

    for (const row of pricesEodTracked) {
      const assigned = assignmentsBySymbol.get(row.symbol);
      if (assigned === undefined) assignmentsToCreate.push(row.symbol);
      else if (assigned) existingAssignmentsEnabled.push(row.symbol);
      else existingAssignmentsDisabled.push(row.symbol);
    }

    const unsupportedSchedules: UnsupportedCalculation[] =
      calculationsResult.results
        .filter((row) => row.cron !== null && row.cron.trim().length > 0)
        .map((row) => ({
          id: row.calculation_id,
          name: row.name,
          type: row.type,
          cron: row.cron!,
          enabled: row.enabled === 1,
          lastScheduledSlot: row.last_scheduled_slot,
          reason:
            "Arbitrary calculation cron schedules are unsupported in the workflow model and are not translated automatically",
        }));

    const snapshotsByPortfolio = new Map<string, SnapshotRow[]>();
    for (const row of snapshotsResult.results) {
      const list = snapshotsByPortfolio.get(row.portfolio_id) ?? [];
      list.push(row);
      snapshotsByPortfolio.set(row.portfolio_id, list);
    }
    const holdingsByPortfolio = new Map<string, HoldingRow[]>();
    for (const row of holdingsResult.results) {
      const list = holdingsByPortfolio.get(row.portfolio_id) ?? [];
      list.push(row);
      holdingsByPortfolio.set(row.portfolio_id, list);
    }
    const mapCounts = (rows: readonly CountByPortfolioRow[]) =>
      new Map(rows.map((row) => [row.portfolio_id, row.count]));
    const calcPortfolioRefs = mapCounts(calcPortfolioRefsResult.results);
    const calcRunRefs = mapCounts(calcRunRefsResult.results);
    const workflowAssignmentRefs = mapCounts(
      workflowAssignmentRefsResult.results,
    );
    const workflowRunRefs = new Map(
      workflowRunRefsResult.results.map((row) => [
        row.portfolio_id,
        { total: row.total, active: row.active ?? 0 },
      ]),
    );
    const publicationRefs = mapCounts(publicationRefsResult.results);

    const real: RealPortfolioSummary[] = [];
    const generatedSingleAssetRemovable: GeneratedSingleAssetPortfolio[] = [];
    const generatedSingleAssetRetained: GeneratedSingleAssetPortfolio[] = [];
    const unverifiedAssetPortfolios: UnverifiedAssetPortfolio[] = [];

    for (const portfolio of portfoliosResult.results) {
      const snapshots = snapshotsByPortfolio.get(portfolio.portfolio_id) ?? [];
      const holdings = holdingsByPortfolio.get(portfolio.portfolio_id) ?? [];

      if (portfolio.asset_symbol === null) {
        real.push({
          id: portfolio.portfolio_id,
          name: portfolio.name,
          snapshotCount: snapshots.length,
          holdingsCount: holdings.length,
        });
        continue;
      }

      const matchesGeneratedShape =
        snapshots.length === 1 &&
        snapshots[0]!.holdings_date === SINGLE_ASSET_HOLDINGS_DATE &&
        holdings.length === 1 &&
        holdings[0]!.source === "legacy" &&
        holdings[0]!.dataset === PRICES_EOD_DATASET &&
        holdings[0]!.holdings_date === SINGLE_ASSET_HOLDINGS_DATE &&
        holdings[0]!.symbol === portfolio.asset_symbol &&
        holdings[0]!.weight === 1;

      if (!matchesGeneratedShape) {
        unverifiedAssetPortfolios.push({
          id: portfolio.portfolio_id,
          name: portfolio.name,
          assetSymbol: portfolio.asset_symbol,
          reason:
            "Portfolio has asset_symbol set but does not match the generated 1900-01-01 single-holding weight-1 shape",
        });
        continue;
      }

      const runCounts = workflowRunRefs.get(portfolio.portfolio_id) ?? {
        total: 0,
        active: 0,
      };
      const references: PortfolioReferenceCounts = {
        calculationPortfolios:
          calcPortfolioRefs.get(portfolio.portfolio_id) ?? 0,
        calculationRuns: calcRunRefs.get(portfolio.portfolio_id) ?? 0,
        workflowAssignments:
          workflowAssignmentRefs.get(portfolio.portfolio_id) ?? 0,
        workflowRuns: runCounts.total,
        activeWorkflowRuns: runCounts.active,
        datasetPublications: publicationRefs.get(portfolio.portfolio_id) ?? 0,
      };
      const reasons = referenceReasons(references);
      const removable = reasons.length === 0;
      const entry: GeneratedSingleAssetPortfolio = {
        id: portfolio.portfolio_id,
        name: portfolio.name,
        assetSymbol: portfolio.asset_symbol,
        references,
        removable,
        reason: removable
          ? "Unused generated single-asset portfolio"
          : reasons.join("; "),
      };
      if (removable) generatedSingleAssetRemovable.push(entry);
      else generatedSingleAssetRetained.push(entry);
    }

    return {
      dryRun: true,
      downloadSchedule,
      trackedSymbols: {
        total: tracked.length,
        pricesEodTotal: pricesEodTracked.length,
        pricesEodEnabled: pricesEodTracked.filter((row) => row.enabled).length,
        pricesEodDisabled: pricesEodTracked.filter((row) => !row.enabled)
          .length,
        unsupportedDatasets,
      },
      assets: {
        existingCount: assetsResult.results.length,
        toCreate,
        alreadyAligned,
        conflicts,
      },
      workflow: {
        workflowId: DEFAULT_PRICES_EOD_WORKFLOW_ID,
        name: desiredSpec.name,
        desiredScheduleHourUtc: desiredSpec.schedule.hourUtc,
        desiredEnabled: desiredSpec.enabled,
        definitionStatus,
        defaultStatus: defaultRow === null ? "missing" : "exists",
        assignmentsToCreate,
        existingAssignmentsEnabled,
        existingAssignmentsDisabled,
      },
      calculations: {
        total: calculationsResult.results.length,
        unsupportedSchedules,
      },
      portfolios: {
        total: portfoliosResult.results.length,
        real,
        generatedSingleAssetRemovable,
        generatedSingleAssetRetained,
        unverifiedAssetPortfolios,
      },
      retainedData: {
        ingestionRuns,
        processingJobs,
        datasetPublications,
        portfolioHoldings,
        portfolioAssetHoldings,
        scheduleRuns,
        calculationRuns,
        workflowRuns,
      },
    } satisfies MigrationInventoryReport;
  },
);

/**
 * Idempotently migrate legacy `prices_eod` registrations into `assets`, seed
 * the standard daily EOD prices workflow definition, register it as the
 * `asset` default, create explicit assignments for migrated assets without
 * overwriting disabled assignments or conflicting custom assets, and remove
 * positively identified unused generated single-asset portfolios.
 *
 * Running this operation a second time performs zero mutations. Real
 * portfolios, `portfolio_holdings` (never duplicated into
 * `portfolio_asset_holdings`), `ingestion_runs`, `processing_jobs`,
 * `dataset_publications`, and `calculations` are preserved intact.
 */
export const applyMigration = Effect.fn("WorkflowMigration.apply")(function* (
  db: D1Database,
  options: MigrationOptions = {},
) {
  const now = options.now ?? new Date().toISOString();
  const registry = options.registry ?? defaultRegistry();
  const inventoryBefore = yield* inventoryMigration(db, { now, registry });
  const desiredSpec = defaultPricesEodWorkflowSpec(
    inventoryBefore.downloadSchedule,
  );
  yield* validateDefaultSpec(desiredSpec, registry);

  const createdAssets: string[] = [];
  if (inventoryBefore.assets.toCreate.length > 0) {
    const { results: trackedRows } = yield* query(
      () =>
        db
          .prepare(
            `SELECT * FROM tracked_symbols WHERE dataset = ? ORDER BY symbol`,
          )
          .bind(PRICES_EOD_DATASET)
          .all<TrackedSymbolRow>(),
      "Could not load tracked_symbols for asset seeding",
    );
    const toCreateSet = new Set(inventoryBefore.assets.toCreate);
    const statements = trackedRows
      .filter((row) => toCreateSet.has(row.symbol))
      .map((row) =>
        db
          .prepare(
            `INSERT INTO assets
               (symbol, provider, backfill_start_date, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (symbol) DO NOTHING
             RETURNING symbol`,
          )
          .bind(
            row.symbol,
            row.provider,
            row.backfill_start_date,
            row.enabled,
            row.created_at,
            row.updated_at,
          ),
      );
    if (statements.length > 0) {
      const results = yield* query(
        () => db.batch(statements),
        "Could not seed assets from tracked_symbols",
      );
      for (const result of results) {
        for (const row of (result.results ?? []) as { symbol: string }[])
          createdAssets.push(row.symbol);
      }
    }
  }

  let createdWorkflowDefinition = false;
  if (inventoryBefore.workflow.definitionStatus === "missing") {
    const inserted = yield* query(
      () =>
        db
          .prepare(
            `INSERT INTO workflow_definitions
               (workflow_id, name, scope, enabled, schedule_hour_utc, steps_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (workflow_id) DO NOTHING
             RETURNING workflow_id`,
          )
          .bind(
            DEFAULT_PRICES_EOD_WORKFLOW_ID,
            desiredSpec.name,
            desiredSpec.scope,
            Number(desiredSpec.enabled),
            desiredSpec.schedule.hourUtc,
            JSON.stringify(desiredSpec.steps),
            now,
            now,
          )
          .first<{ workflow_id: string }>(),
      "Could not seed default workflow definition",
    );
    createdWorkflowDefinition = inserted !== null;
  }

  let createdWorkflowDefault = false;
  if (inventoryBefore.workflow.defaultStatus === "missing") {
    const inserted = yield* query(
      () =>
        db
          .prepare(
            `INSERT INTO workflow_defaults (subject_kind, workflow_id, created_at)
             SELECT 'asset', workflow_id, ?2
             FROM workflow_definitions
             WHERE workflow_id = ?1 AND scope = 'asset'
             ON CONFLICT (subject_kind, workflow_id) DO NOTHING
             RETURNING workflow_id`,
          )
          .bind(DEFAULT_PRICES_EOD_WORKFLOW_ID, now)
          .first<{ workflow_id: string }>(),
      "Could not register default asset workflow",
    );
    createdWorkflowDefault = inserted !== null;
  }

  const createdAssignments: string[] = [];
  if (inventoryBefore.workflow.assignmentsToCreate.length > 0) {
    const statements = inventoryBefore.workflow.assignmentsToCreate.map(
      (symbol) =>
        db
          .prepare(
            `INSERT INTO workflow_assignments
               (workflow_id, subject_kind, subject_id, enabled, created_at, updated_at)
             SELECT d.workflow_id, 'asset', a.symbol, 1, ?3, ?3
             FROM workflow_definitions d
             JOIN assets a ON a.symbol = ?2
             WHERE d.workflow_id = ?1 AND d.scope = 'asset'
             ON CONFLICT (workflow_id, subject_kind, subject_id) DO NOTHING
             RETURNING subject_id`,
          )
          .bind(DEFAULT_PRICES_EOD_WORKFLOW_ID, symbol, now),
    );
    const results = yield* query(
      () => db.batch(statements),
      "Could not create explicit workflow assignments",
    );
    for (const result of results) {
      for (const row of (result.results ?? []) as { subject_id: string }[])
        createdAssignments.push(row.subject_id);
    }
  }

  const removedSingleAssetPortfolios: GeneratedSingleAssetPortfolio[] = [];
  for (const portfolio of inventoryBefore.portfolios
    .generatedSingleAssetRemovable) {
    const [deleted] = yield* query(
      () =>
        db.batch([
          db
            .prepare(
              `DELETE FROM portfolios
               WHERE portfolio_id = ?1
                 AND asset_symbol IS NOT NULL
                 AND (SELECT count(*) FROM portfolio_snapshots s WHERE s.portfolio_id = ?1) = 1
                 AND EXISTS (
                   SELECT 1 FROM portfolio_snapshots s
                   WHERE s.portfolio_id = ?1 AND s.holdings_date = ?2
                 )
                 AND (
                   (SELECT count(*) FROM portfolio_holdings h WHERE h.portfolio_id = ?1)
                   + (SELECT count(*) FROM portfolio_asset_holdings ah WHERE ah.portfolio_id = ?1)
                 ) = 1
                 AND EXISTS (
                   SELECT 1 FROM portfolio_holdings h
                   WHERE h.portfolio_id = ?1
                     AND h.holdings_date = ?2
                     AND h.dataset = ?3
                     AND h.symbol = portfolios.asset_symbol
                     AND h.weight = 1
                 )
                 AND NOT EXISTS (SELECT 1 FROM calculation_portfolios cp WHERE cp.portfolio_id = ?1)
                 AND NOT EXISTS (
                   SELECT 1 FROM calculation_runs r, json_each(r.portfolios_json) j
                   WHERE r.portfolios_json IS NOT NULL
                     AND j.value ->> '$.portfolioId' = ?1
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM workflow_assignments wa
                   WHERE wa.subject_kind = 'portfolio' AND wa.subject_id = ?1
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM workflow_runs wr
                   WHERE wr.subject_kind = 'portfolio' AND wr.subject_id = ?1
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM dataset_publications dp
                   WHERE dp.subject_kind = 'portfolio' AND dp.subject_id = ?1
                 )
               RETURNING portfolio_id`,
            )
            .bind(portfolio.id, SINGLE_ASSET_HOLDINGS_DATE, PRICES_EOD_DATASET),
          // Clean child rows if the SQLite connection does not have foreign-key cascade enabled.
          db
            .prepare(
              `DELETE FROM portfolio_holdings
               WHERE portfolio_id = ?1
                 AND NOT EXISTS (SELECT 1 FROM portfolios WHERE portfolio_id = ?1)`,
            )
            .bind(portfolio.id),
          db
            .prepare(
              `DELETE FROM portfolio_asset_holdings
               WHERE portfolio_id = ?1
                 AND NOT EXISTS (SELECT 1 FROM portfolios WHERE portfolio_id = ?1)`,
            )
            .bind(portfolio.id),
          db
            .prepare(
              `DELETE FROM portfolio_snapshots
               WHERE portfolio_id = ?1
                 AND NOT EXISTS (SELECT 1 FROM portfolios WHERE portfolio_id = ?1)`,
            )
            .bind(portfolio.id),
        ]),
      `Could not remove unused generated single-asset portfolio ${portfolio.id}`,
    );
    if ((deleted?.results.length ?? 0) > 0)
      removedSingleAssetPortfolios.push(portfolio);
  }

  const inventoryAfter = yield* inventoryMigration(db, { now, registry });
  const mutations =
    createdAssets.length +
    Number(createdWorkflowDefinition) +
    Number(createdWorkflowDefault) +
    createdAssignments.length +
    removedSingleAssetPortfolios.length;

  return {
    dryRun: false,
    appliedAt: now,
    workflowId: DEFAULT_PRICES_EOD_WORKFLOW_ID,
    createdAssets,
    skippedConflictingAssets: inventoryBefore.assets.conflicts,
    unsupportedTrackedSymbols:
      inventoryBefore.trackedSymbols.unsupportedDatasets,
    createdWorkflowDefinition,
    createdWorkflowDefault,
    createdAssignments,
    preservedDisabledAssignments:
      inventoryBefore.workflow.existingAssignmentsDisabled,
    removedSingleAssetPortfolios,
    retainedSingleAssetPortfolios:
      inventoryAfter.portfolios.generatedSingleAssetRetained,
    unverifiedAssetPortfolios:
      inventoryAfter.portfolios.unverifiedAssetPortfolios,
    unsupportedCalculations: inventoryBefore.calculations.unsupportedSchedules,
    mutations,
    inventoryAfter,
  } satisfies MigrationApplyReport;
});

/**
 * Explicit switchover operation: verifies migrated workflow state is complete
 * and enabled, pauses the legacy `download_schedule`, and reports readiness to
 * deploy `WORKFLOW_DISPATCH = "on"`.
 */
export const cutoverDownloads = Effect.fn("WorkflowMigration.cutover")(
  function* (db: D1Database, options: MigrationOptions = {}) {
    const now = options.now ?? new Date().toISOString();
    const inventory = yield* inventoryMigration(db, options);

    if (inventory.workflow.definitionStatus === "missing") {
      return yield* new MigrationError({
        kind: "precondition",
        message:
          "Default download workflow definition is missing; apply the workflow migration before cutting downloads over",
      });
    }
    if (inventory.workflow.defaultStatus === "missing") {
      return yield* new MigrationError({
        kind: "precondition",
        message:
          "Default download workflow is not registered in workflow_defaults for assets; apply the workflow migration first",
      });
    }
    if (inventory.assets.toCreate.length > 0) {
      return yield* new MigrationError({
        kind: "precondition",
        message: `Unmigrated prices_eod assets remain (${inventory.assets.toCreate.join(", ")}); apply the workflow migration first`,
      });
    }
    if (inventory.workflow.assignmentsToCreate.length > 0) {
      return yield* new MigrationError({
        kind: "precondition",
        message: `Migrated assets are missing workflow assignments (${inventory.workflow.assignmentsToCreate.join(", ")}); apply the workflow migration first`,
      });
    }

    const definition = yield* query(
      () =>
        db
          .prepare(
            `SELECT workflow_id, name, scope, enabled, schedule_hour_utc, steps_json
             FROM workflow_definitions WHERE workflow_id = ?`,
          )
          .bind(DEFAULT_PRICES_EOD_WORKFLOW_ID)
          .first<DefinitionRow>(),
      "Could not verify default workflow definition",
    );
    if (definition === null || definition.scope !== "asset") {
      return yield* new MigrationError({
        kind: "precondition",
        message:
          "Default download workflow definition is missing or has non-asset scope",
      });
    }
    if (definition.enabled !== 1) {
      return yield* new MigrationError({
        kind: "precondition",
        message:
          "Default download workflow definition is disabled; enable it before cutting downloads over",
      });
    }

    const assignedCounts = yield* query(
      () =>
        db
          .prepare(
            `SELECT count(*) AS total,
                    sum(CASE WHEN wa.enabled = 1 AND a.enabled = 1 THEN 1 ELSE 0 END) AS active
             FROM workflow_assignments wa
             JOIN assets a ON a.symbol = wa.subject_id
             WHERE wa.workflow_id = ? AND wa.subject_kind = 'asset'`,
          )
          .bind(DEFAULT_PRICES_EOD_WORKFLOW_ID)
          .first<{ total: number; active: number | null }>(),
      "Could not count assigned assets for cutover",
    );

    const pausedBefore = inventory.downloadSchedule.paused;
    if (!pausedBefore) {
      yield* query(
        () =>
          db
            .prepare(
              `UPDATE download_schedule SET paused = 1, updated_at = ? WHERE id = 1`,
            )
            .bind(now)
            .run(),
        "Could not pause legacy download_schedule",
      );
    }

    return {
      operation: "cutover",
      performedAt: now,
      workflowId: definition.workflow_id,
      workflowEnabled: definition.enabled === 1,
      workflowScheduleHourUtc: definition.schedule_hour_utc,
      assignedAssetsCount: assignedCounts?.total ?? 0,
      enabledAssignmentsCount: assignedCounts?.active ?? 0,
      legacySchedulePausedBefore: pausedBefore,
      legacySchedulePausedAfter: true,
      readyForWorkflowDispatchOn: true,
      nextStep:
        'Deploy the Worker with WORKFLOW_DISPATCH = "on" so the hourly cron dispatches workflows exclusively.',
    } satisfies CutoverReport;
  },
);

/**
 * Explicit rollback operation: unpauses legacy `download_schedule` so the
 * legacy downloader can resume ownership once `WORKFLOW_DISPATCH = "off"` is
 * deployed.
 */
export const rollbackDownloads = Effect.fn("WorkflowMigration.rollback")(
  function* (db: D1Database, options: MigrationOptions = {}) {
    const now = options.now ?? new Date().toISOString();
    yield* ensureSchemaReady(db);
    const schedule = yield* loadDownloadSchedule(db);

    if (schedule.paused) {
      yield* query(
        () =>
          db
            .prepare(
              `UPDATE download_schedule SET paused = 0, updated_at = ? WHERE id = 1`,
            )
            .bind(now)
            .run(),
        "Could not unpause legacy download_schedule",
      );
    }

    return {
      operation: "rollback",
      performedAt: now,
      legacySchedulePausedBefore: schedule.paused,
      legacySchedulePausedAfter: false,
      legacyScheduleHourUtc: schedule.hourUtc,
      nextStep:
        'Ensure WORKFLOW_DISPATCH = "off" is deployed so the legacy download schedule owns automatic downloads.',
    } satisfies RollbackReport;
  },
);

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * Render an idempotent, reviewable SQL script equivalent to `applyMigration`
 * for remote execution via `wrangler d1 execute --remote --file`.
 */
export const renderApplyMigrationSql = (
  now = new Date().toISOString(),
  registry: StepTypes = defaultRegistry(),
): string => {
  const sampleSpec = defaultPricesEodWorkflowSpec({
    hourUtc: 0,
    paused: false,
  });
  const issues = validateWorkflowSpec(sampleSpec, registry);
  if (issues.length > 0) {
    throw new Error(
      `Invalid default workflow spec: ${issues.map((i) => i.message).join("; ")}`,
    );
  }
  const workflowIdSql = sqlLiteral(DEFAULT_PRICES_EOD_WORKFLOW_ID);
  const workflowNameSql = sqlLiteral(DEFAULT_PRICES_EOD_WORKFLOW_NAME);
  const stepsSql = sqlLiteral(JSON.stringify(sampleSpec.steps));
  const nowSql = sqlLiteral(now);
  const datasetSql = sqlLiteral(PRICES_EOD_DATASET);
  const singleDateSql = sqlLiteral(SINGLE_ASSET_HOLDINGS_DATE);

  return [
    "-- Idempotent workflow migration: seed assets, default download workflow, defaults, and assignments,",
    "-- and remove unused generated single-asset portfolios without modifying real portfolios or retained history.",
    "",
    "-- 1. Seed assets from tracked_symbols (prices_eod only), preserving existing custom assets.",
    `INSERT INTO assets (symbol, provider, backfill_start_date, enabled, created_at, updated_at)`,
    `SELECT symbol, provider, backfill_start_date, enabled, created_at, updated_at`,
    `FROM tracked_symbols`,
    `WHERE dataset = ${datasetSql}`,
    `ON CONFLICT (symbol) DO NOTHING;`,
    "",
    "-- 2. Seed the deterministic standard EOD prices download workflow definition.",
    `INSERT INTO workflow_definitions`,
    `  (workflow_id, name, scope, enabled, schedule_hour_utc, steps_json, created_at, updated_at)`,
    `SELECT`,
    `  ${workflowIdSql},`,
    `  ${workflowNameSql},`,
    `  'asset',`,
    `  CASE WHEN paused = 1 THEN 0 ELSE 1 END,`,
    `  hour_utc,`,
    `  ${stepsSql},`,
    `  ${nowSql},`,
    `  ${nowSql}`,
    `FROM download_schedule`,
    `WHERE id = 1`,
    `ON CONFLICT (workflow_id) DO NOTHING;`,
    "",
    "-- 3. Register the standard workflow as the asset default.",
    `INSERT INTO workflow_defaults (subject_kind, workflow_id, created_at)`,
    `SELECT 'asset', workflow_id, ${nowSql}`,
    `FROM workflow_definitions`,
    `WHERE workflow_id = ${workflowIdSql} AND scope = 'asset'`,
    `ON CONFLICT (subject_kind, workflow_id) DO NOTHING;`,
    "",
    "-- 4. Create explicit assignments for migrated prices_eod assets (never re-enabling disabled ones).",
    `INSERT INTO workflow_assignments`,
    `  (workflow_id, subject_kind, subject_id, enabled, created_at, updated_at)`,
    `SELECT`,
    `  d.workflow_id,`,
    `  'asset',`,
    `  a.symbol,`,
    `  1,`,
    `  ${nowSql},`,
    `  ${nowSql}`,
    `FROM workflow_definitions d`,
    `JOIN tracked_symbols t ON t.dataset = ${datasetSql}`,
    `JOIN assets a ON a.symbol = t.symbol`,
    `WHERE d.workflow_id = ${workflowIdSql} AND d.scope = 'asset'`,
    `ON CONFLICT (workflow_id, subject_kind, subject_id) DO NOTHING;`,
    "",
    "-- 5. Remove positively identified unused generated single-asset portfolios only.",
    `DELETE FROM portfolios`,
    `WHERE asset_symbol IS NOT NULL`,
    `  AND (SELECT count(*) FROM portfolio_snapshots s WHERE s.portfolio_id = portfolios.portfolio_id) = 1`,
    `  AND EXISTS (`,
    `    SELECT 1 FROM portfolio_snapshots s`,
    `    WHERE s.portfolio_id = portfolios.portfolio_id AND s.holdings_date = ${singleDateSql}`,
    `  )`,
    `  AND (`,
    `    (SELECT count(*) FROM portfolio_holdings h WHERE h.portfolio_id = portfolios.portfolio_id)`,
    `    + (SELECT count(*) FROM portfolio_asset_holdings ah WHERE ah.portfolio_id = portfolios.portfolio_id)`,
    `  ) = 1`,
    `  AND EXISTS (`,
    `    SELECT 1 FROM portfolio_holdings h`,
    `    WHERE h.portfolio_id = portfolios.portfolio_id`,
    `      AND h.holdings_date = ${singleDateSql}`,
    `      AND h.dataset = ${datasetSql}`,
    `      AND h.symbol = portfolios.asset_symbol`,
    `      AND h.weight = 1`,
    `  )`,
    `  AND NOT EXISTS (SELECT 1 FROM calculation_portfolios cp WHERE cp.portfolio_id = portfolios.portfolio_id)`,
    `  AND NOT EXISTS (`,
    `    SELECT 1 FROM calculation_runs r, json_each(r.portfolios_json) j`,
    `    WHERE r.portfolios_json IS NOT NULL AND j.value ->> '$.portfolioId' = portfolios.portfolio_id`,
    `  )`,
    `  AND NOT EXISTS (`,
    `    SELECT 1 FROM workflow_assignments wa`,
    `    WHERE wa.subject_kind = 'portfolio' AND wa.subject_id = portfolios.portfolio_id`,
    `  )`,
    `  AND NOT EXISTS (`,
    `    SELECT 1 FROM workflow_runs wr`,
    `    WHERE wr.subject_kind = 'portfolio' AND wr.subject_id = portfolios.portfolio_id`,
    `  )`,
    `  AND NOT EXISTS (`,
    `    SELECT 1 FROM dataset_publications dp`,
    `    WHERE dp.subject_kind = 'portfolio' AND dp.subject_id = portfolios.portfolio_id`,
    `  );`,
    "",
  ].join("\n");
};

/** Render an idempotent SQL script to pause legacy `download_schedule` for cutover. */
export const renderCutoverSql = (now = new Date().toISOString()): string =>
  [
    '-- Explicit download cutover: pause legacy download_schedule before deploying WORKFLOW_DISPATCH = "on".',
    `UPDATE download_schedule`,
    `SET paused = 1, updated_at = ${sqlLiteral(now)}`,
    `WHERE id = 1 AND paused = 0;`,
    "",
  ].join("\n");

/** Render an idempotent SQL script to restore legacy `download_schedule` for rollback. */
export const renderRollbackSql = (now = new Date().toISOString()): string =>
  [
    '-- Explicit download rollback: unpause legacy download_schedule after deploying WORKFLOW_DISPATCH = "off".',
    `UPDATE download_schedule`,
    `SET paused = 0, updated_at = ${sqlLiteral(now)}`,
    `WHERE id = 1 AND paused = 1;`,
    "",
  ].join("\n");
