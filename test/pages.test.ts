import assert from "node:assert/strict";
import test from "node:test";

import { memoryRunArtifacts } from "$/local/artifacts";
import { fixtureSourceFor } from "$/local/eodhd-fixtures";
import { localWorkflowService } from "$/local/runs";
import { PageDataError, pageData } from "$/pages";

import { makeTestDatabase } from "./support/d1";

const WORKFLOW_A = "0c7e8f1a-2b3d-4e5f-8a9b-1c2d3e4f5a6b";
const WORKFLOW_B = "1d8f9a2b-3c4e-4f6a-9b0c-2d3e4f5a6b7c";
const PORTFOLIO_ID = "2e9a0b3c-4d5f-4a7b-8c1d-3e4f5a6b7c8d";
const RUN_1 = "3f0b1c4d-5e6a-4b8c-9d2e-4f5a6b7c8d9e";
const RUN_2 = "4a1c2d5e-6f7b-4c9d-8e3f-5a6b7c8d9e0f";

type Sqlite = ReturnType<typeof makeTestDatabase>["sqlite"];

const setup = () => {
  const { sqlite, db } = makeTestDatabase();
  const { servicesFor } = localWorkflowService({
    db,
    artifacts: memoryRunArtifacts().layer,
    sourceFor: fixtureSourceFor(new Map()),
    platform: { autoStart: false },
  });
  return { sqlite, pages: pageData({} as CloudflareBindings, servicesFor) };
};

const insertAsset = (sqlite: Sqlite, symbol: string, enabled = 1) =>
  sqlite
    .prepare(
      `INSERT INTO assets
         (symbol, provider, backfill_start_date, enabled, created_at, updated_at)
       VALUES (?, 'eodhd', '2024-01-01', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(symbol, enabled);

const insertWorkflow = (
  sqlite: Sqlite,
  id: string,
  name: string,
  scope: "asset" | "portfolio",
  hourUtc: number,
  enabled = 1,
) =>
  sqlite
    .prepare(
      `INSERT INTO workflow_definitions
         (workflow_id, name, scope, enabled, schedule_hour_utc, steps_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(id, name, scope, enabled, hourUtc);

const insertRun = (
  sqlite: Sqlite,
  run: {
    id: string;
    workflowId: string;
    workflowName: string;
    subjectKind: "asset" | "portfolio";
    subjectId: string;
    trigger: "manual" | "schedule";
    status: string;
    createdAt: string;
  },
) =>
  sqlite
    .prepare(
      `INSERT INTO workflow_runs
         (run_id, workflow_id, workflow_name, subject_kind, subject_id, processing_date,
          trigger, status, steps_json, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-10-27', ?, ?, '[]', ?)`,
    )
    .run(
      run.id,
      run.workflowId,
      run.workflowName,
      run.subjectKind,
      run.subjectId,
      run.trigger,
      run.status,
      run.createdAt,
    );

test("the home page summarizes assets, portfolios, workflows, recent runs and publications", async () => {
  const { sqlite, pages } = setup();
  insertAsset(sqlite, "AAPL.US", 1);
  insertAsset(sqlite, "MSFT.US", 1);
  insertAsset(sqlite, "SPY.US", 0);
  sqlite
    .prepare(
      `INSERT INTO portfolios (portfolio_id, name, created_at, updated_at)
       VALUES (?, 'Core equity', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(PORTFOLIO_ID);
  insertWorkflow(sqlite, WORKFLOW_A, "Daily asset prices", "asset", 2, 1);
  insertWorkflow(sqlite, WORKFLOW_B, "Portfolio volatility", "portfolio", 4, 0);
  insertRun(sqlite, {
    id: RUN_1,
    workflowId: WORKFLOW_A,
    workflowName: "Daily asset prices",
    subjectKind: "asset",
    subjectId: "AAPL.US",
    trigger: "schedule",
    status: "completed",
    createdAt: "2026-10-27T02:00:00.000Z",
  });
  insertRun(sqlite, {
    id: RUN_2,
    workflowId: WORKFLOW_B,
    workflowName: "Portfolio volatility",
    subjectKind: "portfolio",
    subjectId: PORTFOLIO_ID,
    trigger: "manual",
    status: "failed",
    createdAt: "2026-10-28T04:00:00.000Z",
  });
  sqlite
    .prepare(
      `INSERT INTO dataset_publications
         (dataset, subject_kind, subject_id, processing_date, workflow_id, run_id, step_id,
          source_artifact, format, schema, etag, size, published_at)
       VALUES
         ('prices_eod', 'asset', 'AAPL.US', '2026-10-27', ?, ?, 'publish',
          'runs/' || ? || '/normalize/prices.parquet', 'parquet', 'prices-eod/v1',
          'etag-1', 512, '2026-10-27T02:01:00.000Z'),
         ('portfolio_volatility', 'portfolio', ?, '2026-10-27', ?, ?, 'publish',
          'runs/' || ? || '/vol/volatility.parquet', 'parquet', 'portfolio-volatility/v1',
          'etag-2', 256, '2026-10-27T04:05:00.000Z')`,
    )
    .run(WORKFLOW_A, RUN_1, RUN_1, PORTFOLIO_ID, WORKFLOW_B, RUN_2, RUN_2);

  const home = await pages.home();

  assert.deepEqual(home.assets, { total: 3, enabled: 2 });
  assert.equal(home.portfolioCount, 1);
  assert.equal(home.workflows.total, 2);
  assert.equal(home.workflows.enabled, 1);
  assert.deepEqual(
    home.workflows.definitions.map((w) => w.name),
    ["Daily asset prices", "Portfolio volatility"],
  );
  assert.deepEqual(
    home.recentRuns.map((r) => r.id),
    [RUN_2, RUN_1],
  );
  assert.equal(home.publications.total, 2);
  assert.deepEqual(
    home.publications.recent.map((p) => p.dataset),
    ["portfolio_volatility", "prices_eod"],
  );

  const portfolioDetail = await pages.portfolioDetail(PORTFOLIO_ID);
  assert.equal(portfolioDetail.portfolio.name, "Core equity");
  assert.deepEqual(
    portfolioDetail.runs.map((r) => r.id),
    [RUN_2],
  );
  assert.deepEqual(
    portfolioDetail.publications.map((p) => p.dataset),
    ["portfolio_volatility"],
  );
  assert.equal((await pages.publications()).length, 2);
});

test("workflowRuns filters by symbol, status and trigger, ignoring unknown values", async () => {
  const { sqlite, pages } = setup();
  insertWorkflow(sqlite, WORKFLOW_A, "Daily asset prices", "asset", 2, 1);
  insertRun(sqlite, {
    id: RUN_1,
    workflowId: WORKFLOW_A,
    workflowName: "Daily asset prices",
    subjectKind: "asset",
    subjectId: "SPY.US",
    trigger: "schedule",
    status: "failed",
    createdAt: "2026-10-27T06:00:00.000Z",
  });
  insertRun(sqlite, {
    id: RUN_2,
    workflowId: WORKFLOW_A,
    workflowName: "Daily asset prices",
    subjectKind: "asset",
    subjectId: "MSFT.US",
    trigger: "manual",
    status: "completed",
    createdAt: "2026-10-28T06:00:00.000Z",
  });

  assert.deepEqual(
    (await pages.workflowRuns({ symbol: " spy.us " })).map((r) => r.id),
    [RUN_1],
  );
  assert.deepEqual(
    (await pages.workflowRuns({ status: "failed" })).map((r) => r.id),
    [RUN_1],
  );
  assert.deepEqual(
    (await pages.workflowRuns({ trigger: "manual" })).map((r) => r.id),
    [RUN_2],
  );
  assert.equal(
    (await pages.workflowRuns({ status: "nonsense", trigger: "other" })).length,
    2,
  );
});

test("unknown asset, portfolio, workflow or run returns 404", async () => {
  const { pages } = setup();
  for (const load of [
    () => pages.asset("not valid"),
    () => pages.asset("MISSING.US"),
    () => pages.portfolio("not-a-uuid"),
    () => pages.portfolio(PORTFOLIO_ID),
    () => pages.workflow("not-a-uuid"),
    () => pages.workflow(WORKFLOW_A),
    () => pages.workflowRun("not-a-uuid"),
    () => pages.workflowRun(RUN_1),
  ]) {
    await assert.rejects(
      load,
      (error: unknown) =>
        error instanceof PageDataError && error.status === 404,
    );
  }
});
