import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Effect, Result, Schema } from "effect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  type PublicationView,
  publishedDatasetKey,
} from "$/datasets/contracts";
import { FileRunArtifactsLive, memoryRunArtifacts } from "$/local/artifacts";
import { fixtureSourceFor, loadEodhdFixtures } from "$/local/eodhd-fixtures";
import { FileDatasetObjectStoreLive } from "$/local/published";
import {
  type LocalPythonService,
  startPythonService,
  uvAvailable,
} from "$/local/python";
import { localWorkflowService } from "$/local/runs";
import { applyMigrations, makeSqliteD1 } from "$/local/sqlite-d1";
import { localSteps } from "$/local/steps";
import { HttpPythonOperationsLive } from "$/operations/client";
import { pageData } from "$/pages";
import { createRoutes } from "$/routes";
import { runScheduledHandlers } from "$/scheduled";
import { WorkflowIdSchema } from "$/workflows/contracts";
import {
  applyMigration,
  cutoverDownloads,
  DEFAULT_PRICES_EOD_WORKFLOW_ID,
  DEFAULT_PRICES_EOD_WORKFLOW_NAME,
  inventoryMigration,
  renderApplyMigrationSql,
  renderCutoverSql,
  renderRollbackSql,
  rollbackDownloads,
} from "$/workflows/migration";
import {
  type DispatchPlatform,
  scheduledWorkflowTick,
  type TickReport,
  type WorkflowDispatchParams,
} from "$/workflows/runs/dispatch";
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "$/workflows/runs/views";

const execFileAsync = promisify(execFile);

const TOKEN = "migration-test-token";
const TEAM = "https://team.cloudflareaccess.com";
const AUD = "migration-test-aud";
const USER_EMAIL = "operator@example.com";
const REAL_PORTFOLIO_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_CALC_ID = "22222222-2222-4222-8222-222222222222";
const MIGRATION_TIME = "2026-11-19T18:00:00.000Z";

const fixtures = loadEodhdFixtures(
  fileURLToPath(new URL("../fixtures/eodhd/", import.meta.url).href),
);
const MIGRATE_SCRIPT = fileURLToPath(
  new URL("../scripts/migrate-workflows.ts", import.meta.url).href,
);

const { publicKey, privateKey } = await generateKeyPair("RS256");
const accessKeys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" }],
});

const signAccessJwt = () =>
  new SignJWT({ email: USER_EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

/**
 * Build a rehearsal SQLite database starting at exact migration 0007
 * (matching production's baseline), seed realistic pre-workflow data, then
 * upgrade through migrations 0008-0014.
 */
const makeRehearsalDatabase = (
  options: {
    readonly path?: string;
    readonly includeEdgeCases?: boolean;
  } = {},
) => {
  const includeEdgeCases = options.includeEdgeCases ?? true;
  const { sqlite, db } = makeSqliteD1(options.path ?? ":memory:", {
    through: "0007",
  });
  sqlite.exec("PRAGMA foreign_keys = ON");

  // Production schedule: 04:00 UTC daily, unpaused.
  sqlite
    .prepare(
      `UPDATE download_schedule SET hour_utc = 4, paused = 0, updated_at = '2026-11-18T00:00:00.000Z' WHERE id = 1`,
    )
    .run();

  const insertTracked = sqlite.prepare(
    `INSERT INTO tracked_symbols
       (dataset, symbol, provider, enabled, backfill_start_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertTracked.run(
    "prices_eod",
    "AAPL.US",
    "eodhd",
    1,
    "2024-01-01",
    "2026-10-01T00:00:00.000Z",
    "2026-10-01T00:00:00.000Z",
  );
  insertTracked.run(
    "prices_eod",
    "MSFT.US",
    "eodhd",
    1,
    "2024-01-01",
    "2026-10-02T00:00:00.000Z",
    "2026-10-02T00:00:00.000Z",
  );
  insertTracked.run(
    "prices_eod",
    "DISABLED.US",
    "eodhd",
    0,
    "2019-01-01",
    "2026-10-04T00:00:00.000Z",
    "2026-10-04T00:00:00.000Z",
  );
  if (includeEdgeCases) {
    insertTracked.run(
      "prices_eod",
      "IBM.US",
      "eodhd",
      1,
      "2020-01-01",
      "2026-10-03T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z",
    );
    // Non-prices_eod tracked symbol (must be reported, not migrated into assets).
    insertTracked.run(
      "dividends",
      "AAPL.US",
      "eodhd",
      1,
      "2020-01-01",
      "2026-10-05T00:00:00.000Z",
      "2026-10-05T00:00:00.000Z",
    );
  }

  // Real multi-asset portfolio with two dated snapshots.
  // Holds AAPL.US (and IBM.US when edge cases are enabled); MSFT.US is
  // intentionally unheld so post-migration asset deletion can be verified.
  sqlite
    .prepare(
      `INSERT INTO portfolios (portfolio_id, name, created_at, updated_at)
       VALUES (?, 'Core equity', '2026-10-10T00:00:00.000Z', '2026-10-15T00:00:00.000Z')`,
    )
    .run(REAL_PORTFOLIO_ID);
  sqlite
    .prepare(
      `INSERT INTO portfolio_snapshots (portfolio_id, holdings_date, created_at) VALUES (?, ?, ?)`,
    )
    .run(REAL_PORTFOLIO_ID, "2024-01-02", "2026-10-10T00:00:00.000Z");
  sqlite
    .prepare(
      `INSERT INTO portfolio_snapshots (portfolio_id, holdings_date, created_at) VALUES (?, ?, ?)`,
    )
    .run(REAL_PORTFOLIO_ID, "2024-01-08", "2026-10-15T00:00:00.000Z");

  const insertHolding = sqlite.prepare(
    `INSERT INTO portfolio_holdings (portfolio_id, holdings_date, dataset, symbol, weight)
     VALUES (?, ?, 'prices_eod', ?, ?)`,
  );
  if (includeEdgeCases) {
    insertHolding.run(REAL_PORTFOLIO_ID, "2024-01-02", "AAPL.US", 0.6);
    insertHolding.run(REAL_PORTFOLIO_ID, "2024-01-02", "IBM.US", 0.4);
    insertHolding.run(REAL_PORTFOLIO_ID, "2024-01-08", "AAPL.US", 0.7);
    insertHolding.run(REAL_PORTFOLIO_ID, "2024-01-08", "IBM.US", 0.3);
  } else {
    insertHolding.run(REAL_PORTFOLIO_ID, "2024-01-02", "AAPL.US", 1.0);
    insertHolding.run(REAL_PORTFOLIO_ID, "2024-01-08", "AAPL.US", 1.0);
  }

  // Retained legacy operational history.
  sqlite
    .prepare(
      `INSERT INTO ingestion_runs
         (run_id, dataset, symbol, provider, requested_from, requested_to, status,
          created_at, completed_at, object_key, object_etag, row_count, observed_from, observed_to)
       VALUES
         ('ing-1', 'prices_eod', 'AAPL.US', 'eodhd', '2024-01-01', '2026-11-18', 'completed',
          '2026-11-18T04:01:00.000Z', '2026-11-18T04:01:10.000Z', 'dataset=prices_eod/symbol=AAPL.US/run=ing-1.json', 'etag-1', 100, '2024-01-02', '2026-11-18'),
         ('ing-2', 'prices_eod', 'MSFT.US', 'eodhd', '2024-01-01', '2026-11-18', 'completed',
          '2026-11-18T04:01:05.000Z', '2026-11-18T04:01:12.000Z', 'dataset=prices_eod/symbol=MSFT.US/run=ing-2.json', 'etag-2', 100, '2024-01-02', '2026-11-18')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO processing_jobs
         (job_id, dataset, symbol, run_id, status, created_at, started_at, completed_at, output_etag)
       VALUES
         ('job-1', 'prices_eod', 'AAPL.US', 'ing-1', 'completed',
          '2026-11-18T04:01:10.000Z', '2026-11-18T04:01:11.000Z', '2026-11-18T04:01:20.000Z', 'parquet-etag-1')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO schedule_runs
         (run_id, trigger, run_date, snapshot_to, status, created_at, completed_at, queued_count, skipped_count)
       VALUES
         ('schedule-2026-11-18', 'schedule', '2026-11-18', '2026-11-17', 'completed',
          '2026-11-18T04:00:00.000Z', '2026-11-18T04:00:05.000Z', 3, 0)`,
    )
    .run();

  if (includeEdgeCases) {
    // Saved calculation with an unsupported arbitrary cron schedule.
    sqlite
      .prepare(
        `INSERT INTO calculations
           (calculation_id, name, type, params_json, cron, enabled, created_at, updated_at, last_scheduled_slot)
         VALUES
           (?, 'Weekday vol', 'ex_ante_vol', '{"window":252}', '0 7 * * 1-5', 1,
            '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z', '2026-11-18T07:00:00.000Z')`,
      )
      .run(LEGACY_CALC_ID);
    sqlite
      .prepare(
        `INSERT INTO calculation_portfolios (calculation_id, portfolio_id, position)
         VALUES (?, ?, 0)`,
      )
      .run(LEGACY_CALC_ID, REAL_PORTFOLIO_ID);
  }

  // Upgrade from 0007 through 0014 (0008 backfills generated single-asset portfolios).
  applyMigrations(sqlite, { from: "0008" });

  let ibmSingleAssetPortfolioId: string | null = null;
  if (includeEdgeCases) {
    const row = sqlite
      .prepare(
        `SELECT portfolio_id FROM portfolios WHERE asset_symbol = 'IBM.US'`,
      )
      .get() as { portfolio_id: string } | undefined;
    assert.ok(
      row,
      "Migration 0008 should have created IBM.US single-asset portfolio",
    );
    ibmSingleAssetPortfolioId = row.portfolio_id;

    // Attach IBM.US's generated single-asset portfolio to the saved calculation
    // and record a calculation run referencing it.
    sqlite
      .prepare(
        `INSERT INTO calculation_portfolios (calculation_id, portfolio_id, position)
         VALUES (?, ?, 1)`,
      )
      .run(LEGACY_CALC_ID, ibmSingleAssetPortfolioId);
    sqlite
      .prepare(
        `INSERT INTO calculation_runs
           (run_id, calculation_id, trigger, as_of, params_json, status, portfolios_json,
            row_count, output_etag, created_at, completed_at)
         VALUES
           ('calc-run-1', ?, 'schedule', '2026-11-18', '{"window":252}', 'completed', ?,
            2, 'calc-etag-1', '2026-11-18T07:00:00.000Z', '2026-11-18T07:00:10.000Z')`,
      )
      .run(
        LEGACY_CALC_ID,
        JSON.stringify([
          {
            portfolioId: REAL_PORTFOLIO_ID,
            status: "completed",
            rowCount: 1,
            error: null,
          },
          {
            portfolioId: ibmSingleAssetPortfolioId,
            status: "completed",
            rowCount: 1,
            error: null,
          },
        ]),
      );
  }

  return { sqlite, db, ibmSingleAssetPortfolioId };
};

const makeFullService = (
  db: D1Database,
  options: {
    readonly dispatch?: string;
    readonly autoStart?: boolean;
    readonly artifacts?: ReturnType<typeof memoryRunArtifacts>["layer"];
    readonly python?: ReturnType<typeof HttpPythonOperationsLive>;
    readonly published?: ReturnType<typeof FileDatasetObjectStoreLive>;
  } = {},
) => {
  const local = localWorkflowService({
    db,
    artifacts: options.artifacts ?? memoryRunArtifacts().layer,
    sourceFor: fixtureSourceFor(fixtures),
    ...(options.python === undefined ? {} : { python: options.python }),
    ...(options.published === undefined
      ? {}
      : { published: options.published }),
    platform: {
      steps: { delayScale: 0 },
      ...(options.autoStart === undefined
        ? {}
        : { autoStart: options.autoStart }),
    },
  });

  const { dependencies } = local;

  const routes = createRoutes(
    dependencies,
    { fetch: () => new Response("app") },
    () => accessKeys,
  );
  const env = {
    MANAGEMENT_API_TOKEN: TOKEN,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    DASHBOARD_ALLOWED_EMAILS: USER_EMAIL,
    WORKFLOW_DISPATCH: options.dispatch ?? "on",
    MARKET_DATA_DB: db,
  } as unknown as CloudflareBindings;

  const api = (path: string, method = "GET", body?: unknown) =>
    routes.request(
      `https://data-service.example.com/api${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  const appApi = async (path: string, method = "GET", body?: unknown) => {
    const jwt = await signAccessJwt();
    return routes.request(
      `https://data-service.example.com/app-api${path}`,
      {
        method,
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                Origin: "https://data-service.example.com",
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  };

  const json = async <T = Record<string, unknown>>(
    response: Response | Promise<Response>,
    status = 200,
  ) => {
    const resolved = await response;
    const body = (await resolved.json()) as T;
    assert.equal(resolved.status, status, JSON.stringify(body));
    return body;
  };

  // Stands in for the dispatch Workflow: runs its body as soon as it starts.
  const dispatches: TickReport[] = [];
  const dispatchPlatformFor = (
    tickEnv: CloudflareBindings,
  ): DispatchPlatform => ({
    create: async ({ params }: { params: WorkflowDispatchParams }) => {
      dispatches.push(
        await scheduledWorkflowTick(
          local.dependencies,
          tickEnv,
          new Date(params.scheduledTime),
          localSteps(new Map(), { delayScale: 0 }),
        ),
      );
    },
    get: async () => ({ status: async () => ({ status: "complete" }) }),
  });

  return {
    dependencies: {
      ...dependencies,
      dispatchPlatformFor,
    },
    env,
    api,
    appApi,
    json,
    dispatches,
    platform: local.platform,
    pages: pageData(env, dependencies),
  };
};

test("default workflow ID satisfies WorkflowIdSchema", () => {
  assert.equal(
    Schema.is(WorkflowIdSchema)(DEFAULT_PRICES_EOD_WORKFLOW_ID),
    true,
  );
});

test("rehearsal from migration 0007: dry-run inventory, idempotent apply, API/app visibility, and zero holding duplication", async () => {
  const { sqlite, db, ibmSingleAssetPortfolioId } = makeRehearsalDatabase();
  const service = makeFullService(db);
  const { api, appApi, json, pages } = service;

  const tableCount = (table: string) =>
    (
      sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;

  // Verify API and app visibility BEFORE migration.
  assert.deepEqual(
    (await json<{ assets: unknown[] }>(api("/assets"))).assets,
    [],
  );
  assert.deepEqual(
    (await json<{ workflows: unknown[] }>(api("/workflows"))).workflows,
    [],
  );
  assert.deepEqual(
    (await json<{ defaults: unknown[] }>(api("/workflow-defaults"))).defaults,
    [],
  );
  assert.deepEqual(
    (await json<{ assignments: unknown[] }>(api("/workflow-assignments")))
      .assignments,
    [],
  );
  const portfoliosBefore = (
    await json<{ portfolios: { id: string; assetSymbol: string | null }[] }>(
      api("/portfolios"),
    )
  ).portfolios;
  assert.equal(portfoliosBefore.length, 5); // 1 real + 4 generated by 0008
  assert.deepEqual(
    (await json<{ assets: unknown[] }>(appApi("/assets"))).assets,
    [],
  );
  assert.equal((await pages.assets()).length, 0);
  assert.equal((await pages.workflows()).length, 0);
  assert.equal((await pages.portfolios()).length, 5);

  // Dry-run inventory report (zero mutations).
  const dryRun = await inventoryMigration(db, { now: MIGRATION_TIME }).pipe(
    Effect.runPromise,
  );
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.downloadSchedule.hourUtc, 4);
  assert.equal(dryRun.downloadSchedule.paused, false);
  assert.equal(dryRun.trackedSymbols.total, 5);
  assert.equal(dryRun.trackedSymbols.pricesEodTotal, 4);
  assert.equal(dryRun.trackedSymbols.pricesEodEnabled, 3);
  assert.equal(dryRun.trackedSymbols.pricesEodDisabled, 1);
  assert.equal(dryRun.trackedSymbols.unsupportedDatasets.length, 1);
  assert.equal(
    dryRun.trackedSymbols.unsupportedDatasets[0]!.dataset,
    "dividends",
  );
  assert.equal(dryRun.assets.existingCount, 0);
  assert.deepEqual(dryRun.assets.toCreate, [
    "AAPL.US",
    "DISABLED.US",
    "IBM.US",
    "MSFT.US",
  ]);
  assert.deepEqual(dryRun.assets.conflicts, []);
  assert.equal(dryRun.workflow.workflowId, DEFAULT_PRICES_EOD_WORKFLOW_ID);
  assert.equal(dryRun.workflow.definitionStatus, "missing");
  assert.equal(dryRun.workflow.defaultStatus, "missing");
  assert.equal(dryRun.workflow.desiredScheduleHourUtc, 4);
  assert.equal(dryRun.workflow.desiredEnabled, true);
  assert.deepEqual(dryRun.workflow.assignmentsToCreate, [
    "AAPL.US",
    "DISABLED.US",
    "IBM.US",
    "MSFT.US",
  ]);
  assert.equal(dryRun.calculations.total, 1);
  assert.equal(dryRun.calculations.unsupportedSchedules.length, 1);
  assert.equal(
    dryRun.calculations.unsupportedSchedules[0]!.cron,
    "0 7 * * 1-5",
  );
  assert.equal(dryRun.portfolios.real.length, 1);
  assert.equal(dryRun.portfolios.real[0]!.id, REAL_PORTFOLIO_ID);
  assert.equal(dryRun.portfolios.real[0]!.snapshotCount, 2);
  assert.equal(dryRun.portfolios.real[0]!.holdingsCount, 4);
  assert.deepEqual(
    dryRun.portfolios.generatedSingleAssetRemovable
      .map((p) => p.assetSymbol)
      .sort(),
    ["AAPL.US", "DISABLED.US", "MSFT.US"],
  );
  assert.equal(dryRun.portfolios.generatedSingleAssetRetained.length, 1);
  assert.equal(
    dryRun.portfolios.generatedSingleAssetRetained[0]!.id,
    ibmSingleAssetPortfolioId,
  );
  assert.equal(
    dryRun.portfolios.generatedSingleAssetRetained[0]!.references
      .calculationPortfolios,
    1,
  );
  assert.equal(
    dryRun.portfolios.generatedSingleAssetRetained[0]!.references
      .calculationRuns,
    1,
  );
  assert.equal(dryRun.retainedData.ingestionRuns, 2);
  assert.equal(dryRun.retainedData.processingJobs, 1);
  assert.equal(dryRun.retainedData.portfolioAssetHoldings, 0);

  // Confirm dry-run performed zero DB mutations.
  assert.equal(tableCount("assets"), 0);
  assert.equal(tableCount("workflow_definitions"), 0);
  assert.equal(tableCount("workflow_defaults"), 0);
  assert.equal(tableCount("workflow_assignments"), 0);
  assert.equal(tableCount("portfolios"), 5);
  assert.equal(tableCount("portfolio_asset_holdings"), 0);

  // Apply migration (first run).
  const firstApply = await applyMigration(db, { now: MIGRATION_TIME }).pipe(
    Effect.runPromise,
  );
  assert.equal(firstApply.dryRun, false);
  assert.deepEqual(firstApply.createdAssets, [
    "AAPL.US",
    "DISABLED.US",
    "IBM.US",
    "MSFT.US",
  ]);
  assert.equal(firstApply.createdWorkflowDefinition, true);
  assert.equal(firstApply.createdWorkflowDefault, true);
  assert.deepEqual(firstApply.createdAssignments, [
    "AAPL.US",
    "DISABLED.US",
    "IBM.US",
    "MSFT.US",
  ]);
  assert.deepEqual(
    firstApply.removedSingleAssetPortfolios.map((p) => p.assetSymbol).sort(),
    ["AAPL.US", "DISABLED.US", "MSFT.US"],
  );
  assert.equal(firstApply.retainedSingleAssetPortfolios.length, 1);
  assert.equal(
    firstApply.retainedSingleAssetPortfolios[0]!.id,
    ibmSingleAssetPortfolioId,
  );
  assert.equal(firstApply.unsupportedCalculations.length, 1);
  assert.equal(firstApply.unsupportedTrackedSymbols.length, 1);
  assert.equal(firstApply.mutations, 4 + 1 + 1 + 4 + 3);

  // Zero holdings duplicated into portfolio_asset_holdings.
  assert.equal(tableCount("portfolio_asset_holdings"), 0);
  // Real portfolio holdings (4) + retained IBM.US single-asset holding (1) = 5.
  assert.equal(tableCount("portfolio_holdings"), 5);
  assert.equal(tableCount("ingestion_runs"), 2);
  assert.equal(tableCount("processing_jobs"), 1);
  assert.equal(tableCount("calculations"), 1);

  // Second apply is strictly a no-op (zero mutations).
  const secondApply = await applyMigration(db, {
    now: "2026-11-19T18:05:00.000Z",
  }).pipe(Effect.runPromise);
  assert.equal(secondApply.mutations, 0);
  assert.deepEqual(secondApply.createdAssets, []);
  assert.equal(secondApply.createdWorkflowDefinition, false);
  assert.equal(secondApply.createdWorkflowDefault, false);
  assert.deepEqual(secondApply.createdAssignments, []);
  assert.deepEqual(secondApply.removedSingleAssetPortfolios, []);

  // Deliberately disable an assignment and re-run apply: must stay disabled.
  await json(
    api(
      `/workflows/${DEFAULT_PRICES_EOD_WORKFLOW_ID}/assignments/asset/MSFT.US`,
      "PATCH",
      { enabled: false },
    ),
  );
  const thirdApply = await applyMigration(db, {
    now: "2026-11-19T18:10:00.000Z",
  }).pipe(Effect.runPromise);
  assert.equal(thirdApply.mutations, 0);
  assert.deepEqual(thirdApply.preservedDisabledAssignments, ["MSFT.US"]);
  const assignmentsAfter = (
    await json<{
      assignments: {
        subject: { kind: string; symbol?: string };
        enabled: boolean;
      }[];
    }>(api("/workflow-assignments"))
  ).assignments;
  const msftAssignment = assignmentsAfter.find(
    (a) => a.subject.kind === "asset" && a.subject.symbol === "MSFT.US",
  );
  assert.equal(msftAssignment?.enabled, false);

  // Verify API and app visibility AFTER migration.
  const assetsApi = (
    await json<{
      assets: {
        symbol: string;
        provider: string;
        backfillStartDate: string;
        enabled: boolean;
      }[];
    }>(api("/assets"))
  ).assets;
  assert.deepEqual(
    assetsApi.map((a) => [
      a.symbol,
      a.provider,
      a.backfillStartDate,
      a.enabled,
    ]),
    [
      ["AAPL.US", "eodhd", "2024-01-01", true],
      ["DISABLED.US", "eodhd", "2019-01-01", false],
      ["IBM.US", "eodhd", "2020-01-01", true],
      ["MSFT.US", "eodhd", "2024-01-01", true],
    ],
  );

  const workflowDetail = await json<{
    id: string;
    name: string;
    scope: string;
    enabled: boolean;
    schedule: { hourUtc: number };
    steps: { id: string; type: string }[];
  }>(api(`/workflows/${DEFAULT_PRICES_EOD_WORKFLOW_ID}`));
  assert.equal(workflowDetail.name, DEFAULT_PRICES_EOD_WORKFLOW_NAME);
  assert.equal(workflowDetail.scope, "asset");
  assert.equal(workflowDetail.enabled, true);
  assert.equal(workflowDetail.schedule.hourUtc, 4);
  assert.deepEqual(
    workflowDetail.steps.map((s) => [s.id, s.type]),
    [
      ["download", "download-prices"],
      ["normalize", "normalize-prices"],
      ["publish", "publish-dataset"],
    ],
  );

  const defaultsApi = (
    await json<{ defaults: { subjectKind: string; workflowId: string }[] }>(
      api("/workflow-defaults"),
    )
  ).defaults;
  assert.deepEqual(
    defaultsApi.map((d) => [d.subjectKind, d.workflowId]),
    [["asset", DEFAULT_PRICES_EOD_WORKFLOW_ID]],
  );

  const portfoliosAfter = (
    await json<{ portfolios: { id: string; assetSymbol: string | null }[] }>(
      api("/portfolios"),
    )
  ).portfolios;
  assert.deepEqual(
    portfoliosAfter.map((p) => p.id).sort(),
    [REAL_PORTFOLIO_ID, ibmSingleAssetPortfolioId!].sort(),
  );

  // Real portfolio snapshots have exact non-duplicated holdings.
  const realPortfolio = await json<{
    id: string;
    snapshots: {
      holdingsDate: string;
      holdings: { symbol: string; weight: number }[];
    }[];
  }>(api(`/portfolios/${REAL_PORTFOLIO_ID}`));
  assert.deepEqual(
    realPortfolio.snapshots.map((s) => [s.holdingsDate, s.holdings]),
    [
      [
        "2024-01-02",
        [
          { symbol: "AAPL.US", weight: 0.6 },
          { symbol: "IBM.US", weight: 0.4 },
        ],
      ],
      [
        "2024-01-08",
        [
          { symbol: "AAPL.US", weight: 0.7 },
          { symbol: "IBM.US", weight: 0.3 },
        ],
      ],
    ],
  );

  // Verify `/app-api/*` and SvelteKit pageData reads match management API.
  assert.equal(
    (await json<{ assets: unknown[] }>(appApi("/assets"))).assets.length,
    4,
  );
  assert.equal(
    (await json<{ workflows: unknown[] }>(appApi("/workflows"))).workflows
      .length,
    1,
  );
  assert.equal(
    (await json<{ defaults: unknown[] }>(appApi("/workflow-defaults"))).defaults
      .length,
    1,
  );
  assert.equal(
    (await json<{ assignments: unknown[] }>(appApi("/workflow-assignments")))
      .assignments.length,
    4,
  );
  assert.equal(
    (await json<{ portfolios: unknown[] }>(appApi("/portfolios"))).portfolios
      .length,
    2,
  );

  assert.equal((await pages.assets()).length, 4);
  const aaplPage = await pages.asset("AAPL.US");
  assert.equal(aaplPage.asset.symbol, "AAPL.US");
  assert.equal(aaplPage.assignments.length, 1);
  assert.equal(
    aaplPage.assignments[0]!.workflowId,
    DEFAULT_PRICES_EOD_WORKFLOW_ID,
  );
  const workflowPage = await pages.workflow(DEFAULT_PRICES_EOD_WORKFLOW_ID);
  assert.equal(workflowPage.isDefault, true);
  assert.equal(workflowPage.assignments.length, 4);
  assert.equal(workflowPage.detail.steps.length, 3);
  assert.equal((await pages.workflowDefaults()).length, 1);
  const portfolioPage = await pages.portfolioDetail(REAL_PORTFOLIO_ID);
  assert.equal(portfolioPage.portfolio.snapshots.length, 2);
});

test("conflicting custom assets are preserved and generated portfolios referenced by workflow/publication tables are retained", async () => {
  const { sqlite, db } = makeRehearsalDatabase();

  // Pre-seed a custom asset for AAPL.US that differs from tracked_symbols.
  sqlite
    .prepare(
      `INSERT INTO assets
         (symbol, provider, backfill_start_date, enabled, created_at, updated_at)
       VALUES ('AAPL.US', 'eodhd', '2025-06-01', 0, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    )
    .run();

  const msftPortfolio = (
    sqlite
      .prepare(
        `SELECT portfolio_id FROM portfolios WHERE asset_symbol = 'MSFT.US'`,
      )
      .get() as { portfolio_id: string }
  ).portfolio_id;
  const disabledPortfolio = (
    sqlite
      .prepare(
        `SELECT portfolio_id FROM portfolios WHERE asset_symbol = 'DISABLED.US'`,
      )
      .get() as { portfolio_id: string }
  ).portfolio_id;

  // Reference MSFT.US's generated portfolio in dataset_publications, and
  // DISABLED.US's in workflow_runs.
  sqlite
    .prepare(
      `INSERT INTO dataset_publications
         (dataset, subject_kind, subject_id, processing_date, workflow_id, run_id, step_id,
          source_artifact, format, schema, etag, size, published_at)
       VALUES
         ('portfolio_volatility', 'portfolio', ?, '2026-11-18',
          '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'publish',
          'runs/44444444-4444-4444-8444-444444444444/vol/data.parquet', 'parquet',
          'portfolio-volatility/v1', 'etag-p', 123, '2026-11-18T05:00:00.000Z')`,
    )
    .run(msftPortfolio);
  sqlite
    .prepare(
      `INSERT INTO workflow_runs
         (run_id, workflow_id, workflow_name, subject_kind, subject_id, processing_date,
          trigger, status, steps_json, created_at)
       VALUES
         ('55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333',
          'Portfolio vol', 'portfolio', ?, '2026-11-18', 'manual', 'completed', '[]',
          '2026-11-18T05:00:00.000Z')`,
    )
    .run(disabledPortfolio);

  const report = await applyMigration(db, { now: MIGRATION_TIME }).pipe(
    Effect.runPromise,
  );
  assert.equal(report.skippedConflictingAssets.length, 1);
  assert.equal(report.skippedConflictingAssets[0]!.symbol, "AAPL.US");
  assert.equal(
    report.skippedConflictingAssets[0]!.existing.backfillStartDate,
    "2025-06-01",
  );

  // Confirm custom AAPL.US asset was NOT overwritten.
  const aapl = sqlite
    .prepare(
      `SELECT backfill_start_date, enabled FROM assets WHERE symbol = 'AAPL.US'`,
    )
    .get() as { backfill_start_date: string; enabled: number };
  assert.equal(aapl.backfill_start_date, "2025-06-01");
  assert.equal(aapl.enabled, 0);

  // Only AAPL.US's unused single-asset portfolio was removed; IBM, MSFT, DISABLED were retained.
  assert.deepEqual(
    report.removedSingleAssetPortfolios.map((p) => p.assetSymbol),
    ["AAPL.US"],
  );
  assert.deepEqual(
    report.retainedSingleAssetPortfolios.map((p) => p.assetSymbol).sort(),
    ["DISABLED.US", "IBM.US", "MSFT.US"],
  );
});

test("emitted SQL scripts reproduce applyMigration, cutover, and rollback idempotently", async () => {
  const { sqlite, db, ibmSingleAssetPortfolioId } = makeRehearsalDatabase();

  const applySql = renderApplyMigrationSql(MIGRATION_TIME);
  sqlite.exec(applySql);
  // Running the emitted SQL a second time must succeed with zero changes.
  sqlite.exec(applySql);

  const afterSql = await inventoryMigration(db, { now: MIGRATION_TIME }).pipe(
    Effect.runPromise,
  );
  assert.equal(afterSql.assets.existingCount, 4);
  assert.deepEqual(afterSql.assets.toCreate, []);
  assert.equal(afterSql.workflow.definitionStatus, "exists_matching");
  assert.equal(afterSql.workflow.defaultStatus, "exists");
  assert.deepEqual(afterSql.workflow.assignmentsToCreate, []);
  assert.deepEqual(afterSql.portfolios.generatedSingleAssetRemovable, []);
  assert.equal(afterSql.portfolios.generatedSingleAssetRetained.length, 1);
  assert.equal(
    afterSql.portfolios.generatedSingleAssetRetained[0]!.id,
    ibmSingleAssetPortfolioId,
  );
  assert.equal(afterSql.retainedData.portfolioAssetHoldings, 0);

  sqlite.exec(renderCutoverSql(MIGRATION_TIME));
  const paused = (
    sqlite
      .prepare(`SELECT paused FROM download_schedule WHERE id = 1`)
      .get() as { paused: number }
  ).paused;
  assert.equal(paused, 1);

  sqlite.exec(renderRollbackSql("2026-11-19T18:30:00.000Z"));
  const resumed = (
    sqlite
      .prepare(`SELECT paused FROM download_schedule WHERE id = 1`)
      .get() as { paused: number }
  ).paused;
  assert.equal(resumed, 0);
});

test("scheduled handler dispatches migrated workflows exclusively and migration cutover/rollback stay idempotent", async () => {
  const { db } = makeRehearsalDatabase();

  // Cutover before migration is rejected with a precondition error.
  const premature = await cutoverDownloads(db, { now: MIGRATION_TIME }).pipe(
    Effect.result,
    Effect.runPromise,
  );
  assert.equal(Result.isFailure(premature), true);
  if (Result.isFailure(premature)) {
    assert.equal(premature.failure.kind, "precondition");
  }

  await applyMigration(db, { now: MIGRATION_TIME }).pipe(Effect.runPromise);

  // autoStart: false keeps scheduled runs queued so we inspect dispatch
  // claims without needing the Python service in this test.
  const service = makeFullService(db, { autoStart: false });
  const envOff = {
    ...service.env,
    WORKFLOW_DISPATCH: "off",
  } as unknown as CloudflareBindings;
  const envOn = {
    ...service.env,
    WORKFLOW_DISPATCH: "on",
  } as unknown as CloudflareBindings;

  // 1. WORKFLOW_DISPATCH="off": hourly handler dispatches nothing.
  const offOutcome = await runScheduledHandlers(
    new Date("2024-01-10T04:00:00Z"),
    envOff,
    service.dependencies,
  );
  assert.deepEqual(offOutcome, { status: "disabled" });
  assert.equal(
    (await service.json<{ runs: unknown[] }>(service.api("/runs"))).runs.length,
    0,
  );

  // 2. WORKFLOW_DISPATCH="on": hourly handler dispatches enabled migrated assets only.
  const workflowOutcome = await runScheduledHandlers(
    new Date("2024-01-11T04:00:00Z"),
    envOn,
    service.dependencies,
  );
  assert.equal(workflowOutcome.status, "started");
  const [dispatched] = service.dispatches;
  assert.equal(dispatched?.status, "dispatched");
  if (dispatched?.status === "dispatched") {
    const symbols = dispatched.runs
      .map((run) => (run.subject.kind === "asset" ? run.subject.symbol : ""))
      .sort();
    // DISABLED.US is not dispatched; only enabled assets are.
    assert.deepEqual(symbols, ["AAPL.US", "IBM.US", "MSFT.US"]);
  }

  // 3. Explicit cutover pauses legacy download_schedule row and is idempotent.
  const cutover1 = await cutoverDownloads(db, {
    now: "2026-11-19T18:15:00.000Z",
  }).pipe(Effect.runPromise);
  assert.equal(cutover1.legacySchedulePausedBefore, false);
  assert.equal(cutover1.legacySchedulePausedAfter, true);
  assert.equal(cutover1.readyForWorkflowDispatchOn, true);
  assert.equal(cutover1.assignedAssetsCount, 4);
  assert.equal(cutover1.enabledAssignmentsCount, 3);

  const cutover2 = await cutoverDownloads(db, {
    now: "2026-11-19T18:16:00.000Z",
  }).pipe(Effect.runPromise);
  assert.equal(cutover2.legacySchedulePausedBefore, true);
  assert.equal(cutover2.legacySchedulePausedAfter, true);

  // 4. Explicit rollback flips download_schedule.paused back to 0.
  const rollback = await rollbackDownloads(db, {
    now: "2026-11-19T18:20:00.000Z",
  }).pipe(Effect.runPromise);
  assert.equal(rollback.legacySchedulePausedBefore, true);
  assert.equal(rollback.legacySchedulePausedAfter, false);
  assert.equal(rollback.legacyScheduleHourUtc, 4);
});

test("CLI script scripts/migrate-workflows.ts supports dry-run, idempotent apply, cutover, rollback, and SQL emission", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "workflow-migrate-cli-"));
  const dbPath = join(tempDir, "rehearsal.sqlite");
  try {
    const { sqlite } = makeRehearsalDatabase({ path: dbPath });
    sqlite.close();

    const runCli = async (args: readonly string[]) => {
      const { stdout } = await execFileAsync("node", [
        "--import",
        "tsx",
        MIGRATE_SCRIPT,
        ...args,
      ]);
      return stdout;
    };

    const dryRunOut = JSON.parse(
      await runCli(["--db", dbPath, "--dry-run", "--now", MIGRATION_TIME]),
    ) as { dryRun: boolean; assets: { toCreate: string[] } };
    assert.equal(dryRunOut.dryRun, true);
    assert.equal(dryRunOut.assets.toCreate.length, 4);

    const apply1 = JSON.parse(
      await runCli(["--db", dbPath, "--apply", "--now", MIGRATION_TIME]),
    ) as { mutations: number; createdAssets: string[] };
    assert.ok(apply1.mutations > 0);
    assert.equal(apply1.createdAssets.length, 4);

    const apply2 = JSON.parse(
      await runCli(["--db", dbPath, "--apply", "--now", MIGRATION_TIME]),
    ) as { mutations: number };
    assert.equal(apply2.mutations, 0);

    const cutoverOut = JSON.parse(
      await runCli(["--db", dbPath, "--cutover", "--now", MIGRATION_TIME]),
    ) as {
      legacySchedulePausedAfter: boolean;
      readyForWorkflowDispatchOn: boolean;
    };
    assert.equal(cutoverOut.legacySchedulePausedAfter, true);
    assert.equal(cutoverOut.readyForWorkflowDispatchOn, true);

    const rollbackOut = JSON.parse(
      await runCli(["--db", dbPath, "--rollback", "--now", MIGRATION_TIME]),
    ) as { legacySchedulePausedAfter: boolean };
    assert.equal(rollbackOut.legacySchedulePausedAfter, false);

    const sqlOut = await runCli([
      "--emit-sql",
      "apply",
      "--now",
      MIGRATION_TIME,
    ]);
    assert.ok(sqlOut.includes(DEFAULT_PRICES_EOD_WORKFLOW_ID));
    assert.ok(sqlOut.includes("INSERT INTO assets"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const SKIP_PYTHON = uvAvailable()
  ? false
  : "uv is not installed, so end-to-end Python normalization cannot run";

describe(
  "migrated asset workflow end-to-end publication and post-migration deletion",
  { skip: SKIP_PYTHON },
  () => {
    let root: string;
    let python: LocalPythonService;

    before(async () => {
      root = mkdtempSync(join(tmpdir(), "workflow-migration-e2e-"));
      python = await startPythonService({
        artifactRoot: join(root, "raw"),
        processedRoot: join(root, "processed"),
      });
    });

    after(async () => {
      await python?.stop();
      rmSync(root, { recursive: true, force: true });
    });

    test("executes migrated workflow through Python, publishes stable prices_eod Parquet, and preserves history/datasets after configuration deletion", async () => {
      const rawDir = join(root, "raw");
      const processedDir = join(root, "processed");
      const { db } = makeRehearsalDatabase({ includeEdgeCases: false });

      await applyMigration(db, { now: MIGRATION_TIME }).pipe(Effect.runPromise);
      await cutoverDownloads(db, { now: MIGRATION_TIME }).pipe(
        Effect.runPromise,
      );

      const service = makeFullService(db, {
        dispatch: "on",
        artifacts: FileRunArtifactsLive(rawDir),
        python: HttpPythonOperationsLive({ fetch }, python.url),
        published: FileDatasetObjectStoreLive(processedDir),
      });

      const outcome = await runScheduledHandlers(
        new Date("2024-01-10T04:00:00Z"),
        service.env,
        service.dependencies,
      );
      assert.equal(outcome.status, "started");
      assert.equal(service.dispatches[0]?.status, "dispatched");
      await service.platform.idle();

      const runs = (
        await service.json<{ runs: WorkflowRunSummary[] }>(service.api("/runs"))
      ).runs;
      assert.equal(runs.length, 2); // AAPL.US and MSFT.US; DISABLED.US did not dispatch
      const runBySymbol = new Map(
        runs.map((run) => [
          run.subject.kind === "asset" ? run.subject.symbol : "",
          run,
        ]),
      );
      const aaplRun = runBySymbol.get("AAPL.US");
      const msftRun = runBySymbol.get("MSFT.US");
      assert.ok(aaplRun && msftRun);
      assert.equal(runBySymbol.has("DISABLED.US"), false);

      const aaplDetail = await service.json<WorkflowRunDetail>(
        service.api(`/runs/${aaplRun.id}`),
      );
      const msftDetail = await service.json<WorkflowRunDetail>(
        service.api(`/runs/${msftRun.id}`),
      );
      assert.equal(aaplDetail.status, "completed");
      assert.equal(msftDetail.status, "completed");

      // Stable canonical Parquet locations match legacy consumer contract.
      const aaplKey = publishedDatasetKey("prices_eod", {
        kind: "asset",
        symbol: "AAPL.US",
      });
      const msftKey = publishedDatasetKey("prices_eod", {
        kind: "asset",
        symbol: "MSFT.US",
      });
      assert.equal(aaplKey, "dataset=prices_eod/symbol=AAPL.US/data.parquet");
      assert.equal(msftKey, "dataset=prices_eod/symbol=MSFT.US/data.parquet");
      assert.equal(existsSync(join(processedDir, aaplKey)), true);
      assert.equal(existsSync(join(processedDir, msftKey)), true);

      const msftMeta = await service.json<PublicationView>(
        service.api("/datasets/prices_eod/asset/MSFT.US"),
      );
      assert.equal(
        msftMeta.producer.workflowId,
        DEFAULT_PRICES_EOD_WORKFLOW_ID,
      );
      assert.equal(
        msftMeta.producer.workflowName,
        DEFAULT_PRICES_EOD_WORKFLOW_NAME,
      );
      assert.equal(msftMeta.processingDate, "2024-01-10");

      const msftDataBefore = await service.api(
        "/datasets/prices_eod/asset/MSFT.US/data",
      );
      assert.equal(msftDataBefore.status, 200);
      assert.equal(
        msftDataBefore.headers.get("Content-Type"),
        "application/vnd.apache.parquet",
      );
      const msftBytesBefore = Buffer.from(await msftDataBefore.arrayBuffer());
      assert.deepEqual(
        msftBytesBefore,
        readFileSync(join(processedDir, msftKey)),
      );

      // Configuration deletion after migration:
      // 1. AAPL.US is held by the real portfolio in portfolio_holdings -> protected (409).
      const deleteHeld = await service.api("/assets/AAPL.US", "DELETE");
      assert.equal(deleteHeld.status, 409);

      // 2. MSFT.US is unheld (its unused generated single-asset portfolio was removed) -> allowed (204).
      const deleteUnheld = await service.api("/assets/MSFT.US", "DELETE");
      assert.equal(deleteUnheld.status, 204);

      // Historical run record and published dataset remain retrievable after asset deletion.
      const msftRunAfterAssetDelete = await service.json<WorkflowRunDetail>(
        service.api(`/runs/${msftRun.id}`),
      );
      assert.equal(msftRunAfterAssetDelete.status, "completed");
      assert.deepEqual(msftRunAfterAssetDelete.subject, {
        kind: "asset",
        symbol: "MSFT.US",
      });

      const msftDataAfterAssetDelete = await service.api(
        "/datasets/prices_eod/asset/MSFT.US/data",
      );
      assert.equal(msftDataAfterAssetDelete.status, 200);
      assert.deepEqual(
        Buffer.from(await msftDataAfterAssetDelete.arrayBuffer()),
        msftBytesBefore,
      );

      // 3. Deleting the workflow definition preserves run history and published datasets.
      const deleteWorkflow = await service.api(
        `/workflows/${DEFAULT_PRICES_EOD_WORKFLOW_ID}`,
        "DELETE",
      );
      assert.equal(deleteWorkflow.status, 204);

      const aaplRunAfterWorkflowDelete = await service.json<WorkflowRunDetail>(
        service.api(`/runs/${aaplRun.id}`),
      );
      assert.equal(aaplRunAfterWorkflowDelete.status, "completed");
      assert.equal(
        aaplRunAfterWorkflowDelete.workflowName,
        DEFAULT_PRICES_EOD_WORKFLOW_NAME,
      );

      const aaplDataAfterWorkflowDelete = await service.api(
        "/datasets/prices_eod/asset/AAPL.US/data",
      );
      assert.equal(aaplDataAfterWorkflowDelete.status, 200);
      assert.deepEqual(
        Buffer.from(await aaplDataAfterWorkflowDelete.arrayBuffer()),
        readFileSync(join(processedDir, aaplKey)),
      );
    });
  },
);
