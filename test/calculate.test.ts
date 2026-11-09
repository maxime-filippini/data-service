import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { requireManagementToken } from "$/auth";
import { ARROW_STREAM, Engine, type EngineError } from "$/calculations/engine";
import { D1PortfoliosLive } from "$/portfolios/d1";
import { createCalculateRoutes, createCalculationTypeRoutes } from "$/routes/calculate";
import { makeTestDatabase } from "./support/d1";
import { type EngineCall, exAnteVol, makeFakeEngine } from "./support/engine";

const PORTFOLIO_ID = "6f1d9a3c-58c4-4d55-9b5e-0a5e2b8f4e11";

const setup = (respond?: (call: EngineCall) => Response | Promise<Response>) => {
  const { sqlite, db } = makeTestDatabase();
  for (const symbol of ["AAPL.US", "MSFT.US"]) {
    sqlite
      .prepare(`INSERT INTO tracked_symbols VALUES ('prices_eod', ?, 'eodhd', 1, '2016-01-01', '2026-01-01', '2026-01-01')`)
      .run(symbol);
  }
  sqlite
    .prepare(`INSERT INTO portfolios (portfolio_id, name, created_at, updated_at) VALUES (?, 'Core', '2026-09-01', '2026-09-01')`)
    .run(PORTFOLIO_ID);
  const snapshot = (date: string, holdings: [string, number][]) => {
    sqlite.prepare(`INSERT INTO portfolio_snapshots VALUES (?, ?, '2026-09-01')`).run(PORTFOLIO_ID, date);
    for (const [symbol, weight] of holdings) {
      sqlite
        .prepare(`INSERT INTO portfolio_holdings VALUES (?, ?, 'prices_eod', ?, ?)`)
        .run(PORTFOLIO_ID, date, symbol, weight);
    }
  };
  snapshot("2026-09-30", [["AAPL.US", 0.6], ["MSFT.US", 0.4]]);
  snapshot("2026-10-15", [["AAPL.US", 1]]);
  snapshot("2026-10-31", [["MSFT.US", 1]]);

  const engine = makeFakeEngine(respond);
  const services = { engineFor: () => engine.layer, portfoliosFor: () => D1PortfoliosLive(db) };
  const types = createCalculationTypeRoutes(services.engineFor, requireManagementToken);
  const calculate = createCalculateRoutes(services, requireManagementToken);
  const env = { MANAGEMENT_API_TOKEN: "management" } as CloudflareBindings;
  const headers = (extra: Record<string, string> = {}) => ({
    Authorization: "Bearer management",
    "Content-Type": "application/json",
    ...extra,
  });
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    calculate.request("/", { method: "POST", headers: headers(extra), body: JSON.stringify(body) }, env);
  const listTypes = (token = "management") =>
    types.request("/", { headers: { Authorization: `Bearer ${token}` } }, env);
  return { calls: engine.calls, post, listTypes, calculate, env };
};

test("both routes require the management token", async () => {
  const { listTypes, calculate, env, calls } = setup();
  assert.equal((await listTypes("wrong")).status, 401);
  const response = await calculate.request("/", { method: "POST", body: "{}" }, env);
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("GET /calculation-types passes the engine's types through", async () => {
  const { listTypes, calls } = setup();
  const response = await listTypes();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { types: [exAnteVol] });
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [["GET", "/types"]]);
});

test("a saved portfolio sends its snapshots up to the as-of date", async () => {
  const { post, calls } = setup();
  const response = await post({
    type: "ex_ante_vol",
    params: { window: 60 },
    asOf: "2026-10-16",
    portfolio: { portfolioId: PORTFOLIO_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await response.json(), { rows: [{ as_of: "2026-10-16", portfolio_id: null, value: 0.2 }] });

  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/calculate",
      accept: "application/json",
      body: {
        type: "ex_ante_vol",
        params: { window: 60 },
        asOf: "2026-10-16",
        portfolio: {
          id: PORTFOLIO_ID,
          name: "Core",
          snapshots: [
            { holdingsDate: "2026-09-30", holdings: [{ symbol: "AAPL.US", weight: 0.6 }, { symbol: "MSFT.US", weight: 0.4 }] },
            { holdingsDate: "2026-10-15", holdings: [{ symbol: "AAPL.US", weight: 1 }] },
          ],
        },
      },
    },
  ]);
});

test("holdings pass through; params and asOf have defaults", async () => {
  const { post, calls } = setup();
  const holdings = [{ symbol: "MSFT.US", weight: -0.5 }, { symbol: "AAPL.US", weight: 1.5 }];
  const before = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal((await post({ type: "ex_ante_vol", portfolio: { holdings } })).status, 200);
  const after = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const body = calls[0]!.body as { params: unknown; asOf: string; portfolio: unknown };
  assert.deepEqual(body.params, {});
  assert.ok(body.asOf === before || body.asOf === after, body.asOf);
  assert.deepEqual(body.portfolio, { holdings });
});

test("a type without a portfolio sends none", async () => {
  const { post, calls } = setup();
  assert.equal((await post({ type: "market_stats", params: {}, asOf: "2026-10-16" })).status, 200);
  assert.equal("portfolio" in (calls[0]!.body as object), false);
});

test("the Accept header reaches the engine so Arrow works", async () => {
  const arrow = new Uint8Array([1, 2, 3]);
  const { post, calls } = setup((call) =>
    call.accept === ARROW_STREAM
      ? new Response(arrow, { headers: { "Content-Type": ARROW_STREAM } })
      : Response.json({ rows: [] }),
  );
  const response = await post(
    { type: "ex_ante_vol", asOf: "2026-10-16", portfolio: { portfolioId: PORTFOLIO_ID } },
    { Accept: ARROW_STREAM },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), ARROW_STREAM);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), arrow);
  assert.equal(calls[0]!.accept, ARROW_STREAM);
});

test("bad requests are refused before calling the engine", async () => {
  const { post, calls } = setup();
  const cases: [string, unknown, number, unknown?][] = [
    ["no type", { portfolio: { holdings: [{ symbol: "AAPL.US", weight: 1 }] } }, 400],
    ["bad date", { type: "ex_ante_vol", asOf: "2026-13-01" }, 400],
    ["zero weight", { type: "ex_ante_vol", portfolio: { holdings: [{ symbol: "AAPL.US", weight: 0 }] } }, 400],
    [
      "repeated symbol",
      { type: "ex_ante_vol", portfolio: { holdings: [{ symbol: "AAPL.US", weight: 1 }, { symbol: "AAPL.US", weight: 1 }] } },
      400,
    ],
    [
      "both portfolio kinds",
      { type: "ex_ante_vol", portfolio: { portfolioId: PORTFOLIO_ID, holdings: [{ symbol: "AAPL.US", weight: 1 }] } },
      400,
    ],
    ["unknown field", { type: "ex_ante_vol", extra: 1 }, 400],
    [
      "untracked symbol",
      { type: "ex_ante_vol", portfolio: { holdings: [{ symbol: "AAPL.US", weight: 1 }, { symbol: "TSLA.US", weight: 1 }] } },
      400,
      { error: "Not tracked in prices_eod: TSLA.US", symbols: ["TSLA.US"] },
    ],
    [
      "unknown portfolio",
      { type: "ex_ante_vol", portfolio: { portfolioId: crypto.randomUUID() } },
      404,
      { error: "The portfolio does not exist" },
    ],
    [
      "no snapshot yet",
      { type: "ex_ante_vol", asOf: "2026-09-29", portfolio: { portfolioId: PORTFOLIO_ID } },
      422,
      { error: "The portfolio has no snapshot on or before 2026-09-29" },
    ],
  ];
  for (const [name, body, status, expected] of cases) {
    const response = await post(body);
    assert.equal(response.status, status, name);
    if (expected !== undefined) assert.deepEqual(await response.json(), expected, name);
  }
  assert.equal(calls.length, 0);
});

test("engine 404, 422 and 500 keep their status", async () => {
  const paramsErrors = [{ type: "greater_than_equal", loc: ["window"], msg: "Input should be at least 2" }];
  const replies: Record<string, Response> = {
    unknown: Response.json({ detail: "Unknown calculation type: unknown" }, { status: 404 }),
    invalid: Response.json({ detail: paramsErrors }, { status: 422 }),
    failing: Response.json({ detail: "No prices_eod data for AAPL.US" }, { status: 500 }),
  };
  const { post } = setup((call) => replies[(call.body as { type: string }).type]!);
  const holdings = [{ symbol: "AAPL.US", weight: 1 }];

  const unknown = await post({ type: "unknown", portfolio: { holdings } });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "Unknown calculation type: unknown" });

  const invalid = await post({ type: "invalid", params: { window: 1 }, portfolio: { holdings } });
  assert.equal(invalid.status, 422);
  assert.deepEqual(await invalid.json(), { error: "Invalid request", detail: paramsErrors });

  const failing = await post({ type: "failing", portfolio: { holdings } });
  assert.equal(failing.status, 500);
  assert.deepEqual(await failing.json(), { error: "No prices_eod data for AAPL.US" });
});

test("an unreachable engine is a 503", async () => {
  const { post, listTypes } = setup(() => Promise.reject(new Error("container crashed")));
  assert.equal((await post({ type: "ex_ante_vol" })).status, 503);
  assert.equal((await listTypes()).status, 503);
});

test("the client validates params and reads run results", async () => {
  const result = {
    status: "partial",
    error: null,
    portfolios: [{ portfolioId: "p1", status: "failed", rowCount: 0, error: "No holdings on or before 2026-10-16" }],
    rowCount: 1,
    outputEtag: "etag",
  };
  const { calls, layer } = makeFakeEngine((call) => {
    if (call.path === "/types/ex_ante_vol/validate") return Response.json({ params: { window: 252 } });
    if (call.path === "/types/nope/validate") return Response.json({ detail: "Unknown calculation type: nope" }, { status: 404 });
    return Response.json(result);
  });
  const use = <A>(program: Effect.Effect<A, EngineError, Engine>) =>
    program.pipe(Effect.provide(layer), Effect.result, Effect.runPromise);

  const valid = await use(Engine.use((engine) => engine.validate("ex_ante_vol", {})));
  assert.deepEqual(valid._tag === "Success" && valid.success, { window: 252 });
  assert.deepEqual(calls[0]!.body, { params: {} });

  const missing = await use(Engine.use((engine) => engine.validate("nope", {})));
  assert.equal(missing._tag === "Failure" && missing.failure.kind, "not_found");

  const request = {
    runId: "run-1",
    type: "ex_ante_vol",
    params: { window: 252 },
    asOf: "2026-10-16",
    portfolios: [],
    outputKey: "calculation=c1/data.parquet",
  };
  const run = await use(Engine.use((engine) => engine.run(request)));
  assert.deepEqual(run._tag === "Success" && run.success, result);
  assert.deepEqual(calls.at(-1), { method: "POST", path: "/runs", accept: "application/json", body: request });
});
