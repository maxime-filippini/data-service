import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Layer } from "effect";

import { requireManagementToken } from "$/auth";
import type { CalculationRun } from "$/calculations";
import { isCronError, parseCron } from "$/calculations/cron";
import { D1CalculationsLive } from "$/calculations/d1";
import { executeRun, type RunWorkflow, type Steps, startRun } from "$/calculations/runs";
import { D1PortfoliosLive } from "$/portfolios/d1";
import { createCalculationRoutes } from "$/routes/calculations";
import { createPortfolioRoutes } from "$/routes/portfolios";
import { makeTestDatabase } from "./support/d1";
import { type EngineCall, exAnteVol, makeFakeEngine } from "./support/engine";

const CORE = "6f1d9a3c-58c4-4d55-9b5e-0a5e2b8f4e11";
const GROWTH = "0b6f3e2a-1c1d-4f7e-9a51-3d2c7e8f9a10";
const MISSING = "9d4c8b7a-2e3f-4a5b-8c6d-7e8f9a0b1c2d";

const breadth = { ...exAnteVol, name: "market_breadth", takesPortfolio: false };

const ok = (status: "completed" | "partial" | "failed", portfolios: unknown[], extra: object = {}) =>
  Response.json({ status, error: null, portfolios, rowCount: 1, outputEtag: '"etag"', ...extra });

/** The engine: two types; `window` must be at least 2 and defaults to 252. */
const defaultEngine = (call: EngineCall): Response => {
  if (call.path === "/types") return Response.json([exAnteVol, breadth]);
  if (call.path.endsWith("/validate")) {
    const { params } = call.body as { params: Record<string, unknown> };
    if (typeof params.window === "number" && params.window < 2) {
      return Response.json({ detail: [{ loc: ["window"], msg: "Input should be greater than or equal to 2" }] }, { status: 422 });
    }
    return Response.json({ params: { window: 252, ...params } });
  }
  if (call.path === "/runs") {
    const { portfolios } = call.body as { portfolios: { id: string }[] };
    return ok("completed", portfolios.map((p) => ({ portfolioId: p.id, status: "completed", rowCount: 1, error: null })));
  }
  return Response.json({ detail: "Not Found" }, { status: 404 });
};

/** A stand-in for the run Workflow binding. Created instances are `running`. */
const makeWorkflow = () => {
  const created: { id: string; params: unknown }[] = [];
  const statuses = new Map<string, string>();
  const state = { failCreate: false };
  const workflow: RunWorkflow = {
    create: async (options) => {
      if (state.failCreate) throw new Error("Workflows are down");
      created.push({ id: options!.id!, params: options!.params });
      statuses.set(options!.id!, "running");
      return { id: options!.id! } as WorkflowInstance;
    },
    get: async (id) => {
      const status = statuses.get(id);
      if (status === undefined) throw new Error("instance.not_found");
      return { id, status: async () => ({ status }) } as unknown as WorkflowInstance;
    },
  };
  return { workflow, created, statuses, state };
};

const setup = (respond: (call: EngineCall) => Response | Promise<Response> = defaultEngine) => {
  const { sqlite, db } = makeTestDatabase();
  for (const symbol of ["AAPL.US", "MSFT.US"]) {
    sqlite
      .prepare(`INSERT INTO tracked_symbols VALUES ('prices_eod', ?, 'eodhd', 1, '2016-01-01', '2026-01-01', '2026-01-01')`)
      .run(symbol);
  }
  for (const [id, name] of [[CORE, "Core"], [GROWTH, "Growth"]]) {
    sqlite.prepare(`INSERT INTO portfolios VALUES (?, ?, '2026-09-01', '2026-09-01')`).run(id, name);
  }
  const snapshot = (id: string, date: string, holdings: [string, number][]) => {
    sqlite.prepare(`INSERT INTO portfolio_snapshots VALUES (?, ?, '2026-09-01')`).run(id, date);
    for (const [symbol, weight] of holdings) {
      sqlite.prepare(`INSERT INTO portfolio_holdings VALUES (?, ?, 'prices_eod', ?, ?)`).run(id, date, symbol, weight);
    }
  };
  snapshot(CORE, "2026-09-30", [["AAPL.US", 0.6], ["MSFT.US", 0.4]]);
  snapshot(CORE, "2026-10-31", [["MSFT.US", 1]]);
  snapshot(GROWTH, "2026-10-15", [["AAPL.US", 1]]);

  const engine = makeFakeEngine(respond);
  const runs = makeWorkflow();
  const services = {
    calculationsFor: () => D1CalculationsLive(db),
    engineFor: () => engine.layer,
    runWorkflowFor: () => runs.workflow,
  };
  const app = createCalculationRoutes(services, requireManagementToken);
  const portfolios = createPortfolioRoutes(() => D1PortfoliosLive(db), requireManagementToken);
  const env = { MANAGEMENT_API_TOKEN: "management" } as CloudflareBindings;
  const request = (path: string, method = "GET", body?: unknown, token = "management") =>
    app.request(
      path,
      {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  const create = async (body: object = {}) => {
    const response = await request("/", "POST", {
      name: "Vol",
      type: "ex_ante_vol",
      params: { window: 60 },
      portfolioIds: [GROWTH, CORE],
      cron: "0 6 * * 1-5",
      ...body,
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as { id: string; params: unknown; portfolioIds: string[]; lastRun: unknown };
  };

  const layer = Layer.mergeAll(D1CalculationsLive(db), D1PortfoliosLive(db), engine.layer);
  const run = <A, E>(program: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    program.pipe(Effect.provide(layer), Effect.runPromise);
  const steps: Steps = { do: (_name, body) => body() };
  const runRow = (runId: string) =>
    sqlite.prepare(`SELECT * FROM calculation_runs WHERE run_id = ?`).get(runId) as Record<string, unknown>;

  return { sqlite, request, create, portfolios, env, calls: engine.calls, runs, run, steps, runRow };
};

test("cron expressions have 5 fields, with ranges, steps, lists and names", () => {
  const parsed = parseCron("0 */6 1,15 JAN-MAR mon-fri");
  assert.ok(!isCronError(parsed));
  assert.deepEqual([...parsed.hours], [0, 6, 12, 18]);
  assert.deepEqual([...parsed.daysOfMonth], [1, 15]);
  assert.deepEqual([...parsed.months], [1, 2, 3]);
  assert.deepEqual([...parsed.daysOfWeek], [1, 2, 3, 4, 5]);
  assert.equal(parsed.eitherDay, true);

  const sundays = parseCron("30 4 * * 7,0");
  assert.ok(!isCronError(sundays));
  assert.deepEqual([...sundays.daysOfWeek], [0]);
  assert.equal(sundays.eitherDay, false);

  const fromTen = parseCron("0 10/5 * * *");
  assert.ok(!isCronError(fromTen));
  assert.deepEqual([...fromTen.hours], [10, 15, 20]);

  for (const invalid of ["", "0 6 * *", "0 6 * * * *", "60 * * * *", "0 24 * * *", "0 6 0 * *", "0 6 * 13 *", "0 6 * * 8",
    "0 */0 * * *", "0 5-2 * * *", "0 a * * *", "0 6 * * MON-", "@daily"]) {
    assert.ok(isCronError(parseCron(invalid)), invalid);
  }
});

test("every route requires the management token", async () => {
  const { request } = setup();
  const id = crypto.randomUUID();
  for (const [path, method] of [
    ["/", "GET"],
    ["/", "POST"],
    [`/${id}`, "GET"],
    [`/${id}`, "PATCH"],
    [`/${id}`, "DELETE"],
    [`/${id}/runs`, "GET"],
    [`/${id}/runs`, "POST"],
    [`/${id}/runs/${id}`, "GET"],
  ] as const) {
    assert.equal((await request(path, method, undefined, "wrong")).status, 401, `${method} ${path}`);
  }
});

test("creating a calculation stores the params the engine returns, and its portfolios in order", async () => {
  const { create, request, calls } = setup();
  const created = await create();
  assert.deepEqual(created.params, { window: 60 });
  assert.deepEqual(created.portfolioIds, [GROWTH, CORE]);
  assert.deepEqual(
    calls.map((call) => [call.method, call.path, call.body]),
    [
      ["GET", "/types", undefined],
      ["POST", "/types/ex_ante_vol/validate", { params: { window: 60 } }],
    ],
  );

  const defaults = await create({ name: "Defaults", params: undefined, enabled: false });
  assert.deepEqual(defaults.params, { window: 252 });

  const list = (await (await request("/")).json()) as { calculations: { name: string; enabled: boolean; outputKey: string }[] };
  assert.deepEqual(
    list.calculations.map((c) => [c.name, c.enabled, c.outputKey]),
    [
      ["Defaults", false, `calculation=${defaults.id}/data.parquet`],
      ["Vol", true, `calculation=${created.id}/data.parquet`],
    ],
  );
  const one = (await (await request(`/${created.id}`)).json()) as { cron: string; lastRun: unknown };
  assert.equal(one.cron, "0 6 * * 1-5");
  assert.equal(one.lastRun, null);
  assert.equal((await request(`/${MISSING}`)).status, 404);
});

test("a calculation must fit its type", async () => {
  const { request } = setup();
  const post = async (body: object) => {
    const response = await request("/", "POST", { name: "X", type: "ex_ante_vol", portfolioIds: [CORE], cron: "0 6 * * *", ...body });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  assert.deepEqual(await post({ type: "nope" }), { status: 422, body: { error: "The engine has no calculation type nope" } });
  assert.equal((await post({ portfolioIds: [] })).status, 422);
  assert.equal((await post({ portfolioIds: undefined })).status, 422);
  assert.equal((await post({ type: "market_breadth" })).status, 422);

  const invalidParams = await post({ params: { window: 1 } });
  assert.equal(invalidParams.status, 422);
  assert.deepEqual(invalidParams.body.detail, [{ loc: ["window"], msg: "Input should be greater than or equal to 2" }]);

  assert.deepEqual(await post({ portfolioIds: [CORE, MISSING] }), {
    status: 422,
    body: { error: `No such portfolios: ${MISSING}`, portfolioIds: [MISSING] },
  });
  assert.equal((await post({ portfolioIds: [CORE, CORE] })).status, 400);
  assert.equal((await post({ cron: "0 6 * *" })).status, 400);
  assert.equal((await post({ cron: "0 25 * * *" })).status, 400);

  assert.equal((await post({ type: "market_breadth", portfolioIds: [] })).status, 201);
});

test("updating a calculation re-checks new params and portfolios; the type can't change", async () => {
  const { create, request, calls } = setup();
  const { id } = await create();
  const patch = async (body: object) => {
    const response = await request(`/${id}`, "PATCH", body);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  calls.length = 0;
  const paused = await patch({ name: "Vol (paused)", cron: "0 7 1 * *", enabled: false, type: "ex_ante_vol" });
  assert.equal(paused.status, 200);
  assert.deepEqual([paused.body.name, paused.body.cron, paused.body.enabled], ["Vol (paused)", "0 7 1 * *", false]);
  assert.equal(calls.length, 0, "no engine call without params or portfolios");

  const params = await patch({ params: {} });
  assert.deepEqual(params.body.params, { window: 252 });
  assert.equal((await patch({ params: { window: 1 } })).status, 422);

  const reordered = await patch({ portfolioIds: [CORE] });
  assert.deepEqual(reordered.body.portfolioIds, [CORE]);
  assert.equal((await patch({ portfolioIds: [] })).status, 422);
  assert.equal((await patch({ portfolioIds: [MISSING] })).status, 422);

  assert.deepEqual(await patch({ type: "market_breadth" }), {
    status: 422,
    body: { error: "A calculation's type can't change; create a new calculation instead" },
  });
  assert.equal((await request(`/${MISSING}`, "PATCH", { enabled: true })).status, 404);
  assert.equal((await patch({ cron: "every day" })).status, 400);
});

test("a portfolio a calculation uses can't be deleted", async () => {
  const { create, request, portfolios, env, sqlite } = setup();
  const { id } = await create({ portfolioIds: [CORE] });

  const blocked = await portfolios.request(`/${CORE}`, { method: "DELETE", headers: { Authorization: "Bearer management" } }, env);
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: "Used by calculations: Vol", calculations: [{ id, name: "Vol" }] });

  sqlite.prepare(`INSERT INTO calculation_runs (run_id, calculation_id, trigger, as_of, params_json, status, created_at)
    VALUES ('r1', ?, 'manual', '2026-10-16', '{}', 'completed', '2026-10-17')`).run(id);
  assert.equal((await request(`/${id}`, "DELETE")).status, 204);
  assert.equal((await request(`/${id}`, "DELETE")).status, 404);
  assert.equal((sqlite.prepare(`SELECT count(*) AS n FROM calculation_runs`).get() as { n: number }).n, 0);

  const deleted = await portfolios.request(`/${CORE}`, { method: "DELETE", headers: { Authorization: "Bearer management" } }, env);
  assert.equal(deleted.status, 204);
});

test("run now starts a Workflow and returns the run ID; a second run is skipped", async () => {
  const { create, request, runs } = setup();
  const { id } = await create();

  const first = await request(`/${id}/runs`, "POST", { asOf: "2026-10-16" });
  assert.equal(first.status, 202);
  const started = (await first.json()) as { runId: string; status: string };
  assert.equal(started.status, "running");
  assert.deepEqual(runs.created, [{ id: started.runId, params: { runId: started.runId } }]);

  const second = (await (await request(`/${id}/runs`, "POST")).json()) as { runId: string; status: string };
  assert.equal(second.status, "skipped");
  assert.equal(runs.created.length, 1);

  const list = (await (await request(`/${id}/runs`)).json()) as { runs: CalculationRun[] };
  // Both runs may share a timestamp, so compare without order.
  const byId = (rows: (string | null)[][]) => [...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(
    byId(list.runs.map((run) => [run.runId, run.status, run.trigger, run.error])),
    byId([
      [second.runId, "skipped", "manual", `Run ${started.runId} was still going`],
      [started.runId, "running", "manual", null],
    ]),
  );
  const skipped = list.runs.find((run) => run.runId === second.runId)!;
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(skipped.asOf, yesterday);
  assert.equal(skipped.completedAt, skipped.createdAt);

  const one = (await (await request(`/${id}/runs/${started.runId}`)).json()) as CalculationRun;
  assert.deepEqual([one.asOf, one.params, one.portfolios], ["2026-10-16", { window: 60 }, null]);
  const calculation = (await (await request(`/${id}`)).json()) as { lastRun: CalculationRun };
  assert.ok([started.runId, second.runId].includes(calculation.lastRun.runId));

  const other = await create({ name: "Other" });
  assert.equal((await request(`/${other.id}/runs/${started.runId}`)).status, 404);
  assert.equal((await request(`/${MISSING}/runs`, "POST")).status, 404);
  assert.equal((await request(`/${MISSING}/runs`)).status, 404);
  assert.equal((await request(`/${id}/runs`, "POST", { asOf: "16/10/2026" })).status, 400);
});

test("a run whose Workflow fails to start is recorded as failed", async () => {
  const { create, request, runs, runRow } = setup();
  const { id } = await create();
  runs.state.failCreate = true;
  const response = await request(`/${id}/runs`, "POST");
  assert.equal(response.status, 500);
  const [row] = (await (await request(`/${id}/runs`)).json() as { runs: CalculationRun[] }).runs;
  assert.equal(row?.status, "failed");
  assert.equal(runRow(row!.runId).error, "Could not start the run: Workflows are down");

  runs.state.failCreate = false;
  assert.equal(((await (await request(`/${id}/runs`, "POST")).json()) as { status: string }).status, "running");
});

test("a run left running by a stopped or missing Workflow is failed, so the next run starts", async () => {
  const { create, runs, run, runRow } = setup();
  const { id } = await create();
  const start = (iso: string) =>
    run(startRun(id, { trigger: "schedule", asOf: "2026-10-16" }, new Date(iso), runs.workflow));

  const first = await start("2026-10-19T06:00:00Z");
  assert.equal(first.status, "running");
  // Still going after an hour: skipped.
  assert.equal((await start("2026-10-19T07:00:00Z")).status, "skipped");

  runs.statuses.set(first.runId, "errored");
  // Within the grace period the Workflow isn't checked.
  assert.equal((await start("2026-10-19T06:04:00Z")).status, "skipped");
  const second = await start("2026-10-19T08:00:00Z");
  assert.equal(second.status, "running");
  assert.equal(runRow(first.runId).status, "failed");
  assert.equal(runRow(first.runId).error, "The run stopped without reporting back (workflow errored)");

  // The Worker crashed between recording the run and creating its Workflow.
  runs.statuses.delete(second.runId);
  assert.equal((await start("2026-10-19T09:00:00Z")).status, "running");
  assert.equal(runRow(second.runId).error, "The run's workflow never started");
});

test("a run sends every portfolio's snapshots up to the as-of date and records the result", async () => {
  const { create, runs, run, steps, calls, runRow } = setup();
  const { id } = await create();
  const { runId } = await run(startRun(id, { trigger: "manual", asOf: "2026-10-16" }, new Date(), runs.workflow));
  calls.length = 0;

  assert.equal(await executeRun({ runId }, steps, run), "completed");
  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/runs",
      accept: "application/json",
      body: {
        runId,
        type: "ex_ante_vol",
        params: { window: 60 },
        asOf: "2026-10-16",
        portfolios: [
          { id: GROWTH, name: "Growth", snapshots: [{ holdingsDate: "2026-10-15", holdings: [{ symbol: "AAPL.US", weight: 1 }] }] },
          {
            id: CORE,
            name: "Core",
            snapshots: [
              { holdingsDate: "2026-09-30", holdings: [{ symbol: "AAPL.US", weight: 0.6 }, { symbol: "MSFT.US", weight: 0.4 }] },
            ],
          },
        ],
        outputKey: `calculation=${id}/data.parquet`,
      },
    },
  ]);
  const row = runRow(runId);
  assert.equal(row.status, "completed");
  assert.equal(row.row_count, 1);
  assert.equal(row.output_etag, '"etag"');
  assert.equal(JSON.parse(row.portfolios_json as string).length, 2);
  assert.ok(row.completed_at);

  // Finished: running it again does nothing.
  calls.length = 0;
  assert.equal(await executeRun({ runId }, steps, run), null);
  assert.equal(calls.length, 0);
});

test("a portfolio with no holdings by the as-of date fails on its own", async () => {
  const { create, runs, run, steps, calls, runRow } = setup();
  const { id } = await create();

  const partial = await run(startRun(id, { trigger: "manual", asOf: "2026-10-01" }, new Date(), runs.workflow));
  assert.equal(await executeRun(partial, steps, run), "partial");
  assert.deepEqual((calls.at(-1)!.body as { portfolios: { id: string }[] }).portfolios.map((p) => p.id), [CORE]);
  assert.deepEqual(JSON.parse(runRow(partial.runId).portfolios_json as string), [
    { portfolioId: GROWTH, status: "failed", rowCount: 0, error: "No holdings on or before 2026-10-01" },
    { portfolioId: CORE, status: "completed", rowCount: 1, error: null },
  ]);

  calls.length = 0;
  const none = await run(startRun(id, { trigger: "manual", asOf: "2026-09-01" }, new Date(), runs.workflow));
  assert.equal(await executeRun(none, steps, run), "failed");
  assert.equal(calls.length, 0, "the engine isn't called");
  assert.equal(runRow(none.runId).error, "All 2 portfolios failed");
});

test("engine failures: rejected runs are recorded, unreachable engines fail the step", async () => {
  let reply: (call: EngineCall) => Response = defaultEngine;
  const { create, runs, run, steps, runRow } = setup((call) => (call.path === "/runs" ? reply(call) : defaultEngine(call)));
  const { id } = await create();
  const next = () => run(startRun(id, { trigger: "manual", asOf: "2026-10-16" }, new Date(), runs.workflow));

  reply = () => ok("failed", [], { error: "Unknown calculation type ex_ante_vol", rowCount: 0, outputEtag: null });
  const removed = await next();
  assert.equal(await executeRun(removed, steps, run), "failed");
  assert.equal(runRow(removed.runId).error, "Unknown calculation type ex_ante_vol");

  reply = () => Response.json({ detail: "Saved calculations only take portfolios with an id" }, { status: 422 });
  const rejected = await next();
  assert.equal(await executeRun(rejected, steps, run), "failed");
  assert.equal(runRow(rejected.runId).error, "The engine rejected the run: Saved calculations only take portfolios with an id");

  reply = () => new Response("boom", { status: 500 });
  const crashed = await next();
  await assert.rejects(executeRun(crashed, steps, run));
  assert.equal(runRow(crashed.runId).status, "failed");
  assert.equal(runRow(crashed.runId).error, "boom");
});
