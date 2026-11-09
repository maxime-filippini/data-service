import assert from "node:assert/strict";
import test from "node:test";

import { D1CalculationsLive } from "$/calculations/d1";
import { D1ScheduleStoreLive } from "$/market-data/schedule/d1";
import { D1PipelineStatusLive } from "$/market-data/status/d1";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { PageDataError, pageData } from "$/pages";
import { D1PortfoliosLive } from "$/portfolios/d1";
import type { Services } from "$/services";
import { makeTestDatabase } from "./support/d1";
import { makeFakeEngine } from "./support/engine";

const CALC_A = "0c7e8f1a-2b3d-4e5f-8a9b-1c2d3e4f5a6b";
const CALC_B = "1d8f9a2b-3c4e-4f6a-9b0c-2d3e4f5a6b7c";
const CALC_PAUSED = "2e9a0b3c-4d5f-4a7b-8c1d-3e4f5a6b7c8d";

const setup = () => {
  const { sqlite, db } = makeTestDatabase();
  const workflow = {
    create: async () => ({ id: "unused" }) as WorkflowInstance,
    get: async (id: string) => ({ id }) as WorkflowInstance,
  };
  const services: Services = {
    statusFor: () => D1PipelineStatusLive(db),
    registryFor: () => D1SymbolRegistryLive(db),
    storeFor: () => D1ScheduleStoreLive(db),
    workflowFor: () => workflow,
    portfoliosFor: () => D1PortfoliosLive(db),
    engineFor: () => makeFakeEngine().layer,
    calculationsFor: () => D1CalculationsLive(db),
    runWorkflowFor: () => workflow,
  } as unknown as Services;
  return { sqlite, pages: pageData({} as CloudflareBindings, services) };
};

type Sqlite = ReturnType<typeof makeTestDatabase>["sqlite"];

const insertSymbol = (sqlite: Sqlite, symbol: string, enabled = 1) =>
  sqlite
    .prepare(
      `INSERT INTO tracked_symbols VALUES ('prices_eod', ?, 'eodhd', ?, '2016-01-01',
         '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(symbol, enabled);

const insertFailedRun = (sqlite: Sqlite, id: string, symbol: string, createdAt: string) =>
  sqlite
    .prepare(
      `INSERT INTO ingestion_runs (run_id, dataset, symbol, provider, requested_from, requested_to,
         status, created_at, completed_at, error)
       VALUES (?, 'prices_eod', ?, 'eodhd', '2016-01-01', '2026-10-27', 'failed', ?, ?, 'Provider said no')`,
    )
    .run(id, symbol, createdAt, createdAt);

const insertCalculation = (sqlite: Sqlite, id: string, name: string, cron: string, enabled = 1) =>
  sqlite
    .prepare(
      `INSERT INTO calculations (calculation_id, name, type, params_json, cron, enabled, created_at, updated_at)
       VALUES (?, ?, 'ex_ante_vol', '{}', ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(id, name, cron, enabled);

const insertCalculationRun = (sqlite: Sqlite, runId: string, calculationId: string, status: string, createdAt: string) =>
  sqlite
    .prepare(
      `INSERT INTO calculation_runs (run_id, calculation_id, trigger, as_of, params_json, status, created_at)
       VALUES (?, ?, 'schedule', '2026-10-27', '{}', ?, ?)`,
    )
    .run(runId, calculationId, status, createdAt);

test("the home page sums up both pipelines", async () => {
  const { sqlite, pages } = setup();
  insertSymbol(sqlite, "AAPL.US");
  insertSymbol(sqlite, "MSFT.US");
  insertSymbol(sqlite, "SPY.US", 0);
  insertFailedRun(sqlite, "r1", "SPY.US", "2026-10-27T06:00:00.000Z");
  insertFailedRun(sqlite, "r2", "MSFT.US", "2026-10-28T06:00:00.000Z");
  insertCalculation(sqlite, CALC_A, "Daily vol", "0 6 * * *");
  insertCalculation(sqlite, CALC_B, "Hourly vol", "0 * * * *");
  insertCalculation(sqlite, CALC_PAUSED, "Paused vol", "0 * * * *", 0);
  insertCalculationRun(sqlite, "c1", CALC_A, "completed", "2026-10-27T06:00:00.000Z");
  insertCalculationRun(sqlite, "c2", CALC_B, "failed", "2026-10-28T09:00:00.000Z");

  const home = await pages.home();

  assert.deepEqual(home.symbols, {
    total: 3,
    scheduled: 2,
    failedDownloads: 2,
    failedRebuilds: 0,
    neverDownloaded: 3,
  });
  assert.deepEqual(
    home.failedRuns.map((run) => run.runId),
    ["r2", "r1"],
  );
  assert.equal(home.schedule.paused, true);
  assert.deepEqual(home.scheduleRuns, []);
  assert.equal(home.portfolioCount, 0);
  assert.equal(home.calculations.total, 3);
  assert.equal(home.calculations.enabled, 2);
  assert.deepEqual(
    home.calculations.latestRuns.map((run) => [run.runId, run.calculationName]),
    [
      ["c2", "Hourly vol"],
      ["c1", "Daily vol"],
    ],
  );
  // Paused calculations aren't upcoming; the hourly one runs next.
  assert.deepEqual(
    home.calculations.upcoming.map((c) => c.name),
    ["Hourly vol", "Daily vol"],
  );
});

test("the runs page filters by symbol and status, ignoring unknown statuses", async () => {
  const { sqlite, pages } = setup();
  insertFailedRun(sqlite, "r1", "SPY.US", "2026-10-27T06:00:00.000Z");
  insertFailedRun(sqlite, "r2", "MSFT.US", "2026-10-28T06:00:00.000Z");

  assert.deepEqual((await pages.runs({ symbol: " spy.us " })).runs.map((run) => run.runId), ["r1"]);
  assert.deepEqual((await pages.runs({ status: "failed" })).runs.length, 2);
  assert.deepEqual((await pages.runs({ status: "completed" })).runs.length, 0);
  assert.deepEqual((await pages.runs({ status: "nonsense" })).runs.length, 2);
});

test("an unknown portfolio or calculation is a 404", async () => {
  const { pages } = setup();
  for (const load of [
    () => pages.portfolio("not-a-uuid"),
    () => pages.portfolio(CALC_A),
    () => pages.calculation("not-a-uuid"),
    () => pages.calculation(CALC_A),
  ]) {
    await assert.rejects(load, (error: unknown) => error instanceof PageDataError && error.status === 404);
  }
});

test("a calculation page has the calculation and its runs, newest first", async () => {
  const { sqlite, pages } = setup();
  insertCalculation(sqlite, CALC_A, "Daily vol", "0 6 * * *");
  insertCalculationRun(sqlite, "c1", CALC_A, "completed", "2026-10-26T06:00:00.000Z");
  insertCalculationRun(sqlite, "c2", CALC_A, "failed", "2026-10-27T06:00:00.000Z");

  const { calculation, runs } = await pages.calculation(CALC_A);
  assert.equal(calculation.name, "Daily vol");
  assert.deepEqual(
    runs.map((run) => run.runId),
    ["c2", "c1"],
  );
});
