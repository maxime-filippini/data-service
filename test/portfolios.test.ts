import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { requireManagementToken } from "$/auth";
import { Portfolios } from "$/portfolios";
import { SymbolRegistry } from "$/market-data/symbol-registry";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { D1PortfoliosLive } from "$/portfolios/d1";
import { createPortfolioRoutes } from "$/routes/portfolios";
import { makeTestDatabase } from "./support/d1";

interface PortfolioBody {
  id: string;
  name: string;
  updatedAt: string;
  snapshots: { holdingsDate: string; holdings: { symbol: string; weight: number }[] }[];
}

const september = { holdingsDate: "2026-09-30", holdings: [{ symbol: "MSFT.US", weight: 0.4 }, { symbol: "AAPL.US", weight: 0.6 }] };
const october = { holdingsDate: "2026-10-15", holdings: [{ symbol: "AAPL.US", weight: 1.5 }, { symbol: "MSFT.US", weight: -0.5 }] };

const setup = () => {
  const { sqlite, db } = makeTestDatabase();
  const track = (symbol: string, enabled = 1) =>
    sqlite
      .prepare(
        `INSERT INTO tracked_symbols VALUES ('prices_eod', ?, 'eodhd', ?, '2016-01-01', '2026-01-01', '2026-01-01')`,
      )
      .run(symbol, enabled);
  track("AAPL.US");
  track("MSFT.US", 0);

  const app = createPortfolioRoutes(() => D1PortfoliosLive(db), requireManagementToken);
  const env = { MANAGEMENT_API_TOKEN: "management" } as CloudflareBindings;
  const request = (path: string, method = "GET", body?: unknown, token = "management") =>
    app.request(
      path,
      {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  const create = async (body: unknown) => {
    const response = await request("/", "POST", body);
    assert.equal(response.status, 201);
    return (await response.json()) as PortfolioBody;
  };
  const count = (table: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { sqlite, db, request, create, count };
};

test("every route requires the management token", async () => {
  const { request } = setup();
  const id = crypto.randomUUID();
  for (const [path, method] of [
    ["/", "GET"],
    ["/", "POST"],
    [`/${id}`, "GET"],
    [`/${id}`, "PATCH"],
    [`/${id}`, "DELETE"],
    [`/${id}/snapshots`, "POST"],
    [`/${id}/snapshots/2026-09-30`, "DELETE"],
  ] as const) {
    assert.equal((await request(path, method, undefined, "wrong")).status, 401, `${method} ${path}`);
  }
});

test("create, list, rename and delete a portfolio", async () => {
  const { request, create, count } = setup();

  const empty = await create({ name: "  Growth  " });
  assert.equal(empty.name, "Growth");
  assert.deepEqual(empty.snapshots, []);

  const core = await create({ name: "Core", snapshot: september });
  assert.deepEqual(core.snapshots.map((s) => s.holdings), [
    [{ symbol: "AAPL.US", weight: 0.6 }, { symbol: "MSFT.US", weight: 0.4 }],
  ]);

  const list = (await (await request("/")).json()) as { portfolios: Record<string, unknown>[] };
  assert.deepEqual(
    list.portfolios.map(({ name, snapshotCount, latestHoldingsDate }) => ({ name, snapshotCount, latestHoldingsDate })),
    [
      { name: "Core", snapshotCount: 1, latestHoldingsDate: "2026-09-30" },
      { name: "Growth", snapshotCount: 0, latestHoldingsDate: null },
    ],
  );

  const renamed = await request(`/${core.id}`, "PATCH", { name: "Core equity" });
  assert.equal(renamed.status, 200);
  const body = (await renamed.json()) as PortfolioBody;
  assert.equal(body.name, "Core equity");
  assert.equal(body.snapshots.length, 1);

  assert.equal((await request(`/${core.id}`, "DELETE")).status, 204);
  assert.equal((await request(`/${core.id}`)).status, 404);
  assert.equal((await request(`/${core.id}`, "DELETE")).status, 404);
  assert.equal((await request(`/${core.id}`, "PATCH", { name: "Gone" })).status, 404);
  assert.equal(count("portfolio_snapshots"), 0);
  assert.equal(count("portfolio_holdings"), 0);
});

test("add and delete snapshots", async () => {
  const { request, create } = setup();
  const { id } = await create({ name: "Core", snapshot: october });

  const added = await request(`/${id}/snapshots`, "POST", september);
  assert.equal(added.status, 201);
  assert.equal(((await added.json()) as { holdingsDate: string }).holdingsDate, "2026-09-30");

  const portfolio = (await (await request(`/${id}`)).json()) as PortfolioBody;
  assert.deepEqual(portfolio.snapshots.map((s) => s.holdingsDate), ["2026-09-30", "2026-10-15"]);

  const duplicate = await request(`/${id}/snapshots`, "POST", september);
  assert.equal(duplicate.status, 409);

  assert.equal((await request(`/${id}/snapshots/2026-09-30`, "DELETE")).status, 204);
  assert.equal((await request(`/${id}/snapshots/2026-09-30`, "DELETE")).status, 404);
  const after = (await (await request(`/${id}`)).json()) as PortfolioBody;
  assert.deepEqual(after.snapshots.map((s) => s.holdingsDate), ["2026-10-15"]);

  assert.equal((await request(`/${crypto.randomUUID()}/snapshots`, "POST", september)).status, 404);
});

test("a symbol's single-asset portfolio can't be changed", async () => {
  const { request, db } = setup();
  await SymbolRegistry.use((registry) =>
    registry.register(
      { dataset: "prices_eod", symbol: "NVDA.US", provider: "eodhd", backfillStartDate: "2016-01-01" },
      "2026-10-28T00:00:00.000Z",
    ),
  ).pipe(Effect.provide(D1SymbolRegistryLive(db)), Effect.runPromise);

  const list = (await (await request("/")).json()) as { portfolios: { id: string; name: string; assetSymbol: string | null }[] };
  const nvda = list.portfolios.find((p) => p.assetSymbol === "NVDA.US");
  assert.ok(nvda);
  assert.equal(nvda.name, "NVDA.US");
  const { id } = nvda;

  const portfolio = (await (await request(`/${id}`)).json()) as PortfolioBody & { assetSymbol: string };
  assert.equal(portfolio.assetSymbol, "NVDA.US");
  assert.deepEqual(portfolio.snapshots.map(({ holdingsDate, holdings }) => ({ holdingsDate, holdings })), [
    { holdingsDate: "1900-01-01", holdings: [{ symbol: "NVDA.US", weight: 1 }] },
  ]);

  for (const [path, method, body] of [
    [`/${id}`, "PATCH", { name: "Nvidia" }],
    [`/${id}`, "DELETE", undefined],
    [`/${id}/snapshots`, "POST", { holdingsDate: "2026-01-02", holdings: [{ symbol: "NVDA.US", weight: 1 }] }],
    [`/${id}/snapshots/1900-01-01`, "DELETE", undefined],
  ] as const) {
    const response = await request(path, method, body);
    assert.equal(response.status, 409, `${method} ${path}`);
    assert.match(((await response.json()) as { error: string }).error, /single-asset portfolio of NVDA\.US/u);
  }
  assert.equal(((await (await request(`/${id}`)).json()) as PortfolioBody).snapshots.length, 1);
});

test("snapshots only hold tracked prices_eod symbols", async () => {
  const { request, create, count } = setup();
  const { id } = await create({ name: "Core" });

  const response = await request(`/${id}/snapshots`, "POST", {
    holdingsDate: "2026-09-30",
    holdings: [{ symbol: "AAPL.US", weight: 1 }, { symbol: "TSLA.US", weight: 1 }, { symbol: "NVDA.US", weight: 1 }],
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { symbols: string[] };
  assert.deepEqual([...body.symbols].sort(), ["NVDA.US", "TSLA.US"]);

  assert.equal(
    (await request("/", "POST", { name: "Bad", snapshot: { holdingsDate: "2026-09-30", holdings: [{ symbol: "TSLA.US", weight: 1 }] } })).status,
    400,
  );
  assert.equal(count("portfolios"), 1);
  assert.equal(count("portfolio_snapshots"), 0);
});

test("invalid input is rejected", async () => {
  const { request, create, count } = setup();
  const { id } = await create({ name: "Core" });

  for (const body of [
    { holdingsDate: "2026-09-31", holdings: [{ symbol: "AAPL.US", weight: 1 }] },
    { holdingsDate: "2026-09-30", holdings: [] },
    { holdingsDate: "2026-09-30", holdings: [{ symbol: "AAPL.US", weight: 0 }] },
    { holdingsDate: "2026-09-30", holdings: [{ symbol: "AAPL.US", weight: "1" }] },
    { holdingsDate: "2026-09-30", holdings: [{ symbol: "aapl", weight: 1 }] },
    { holdingsDate: "2026-09-30", holdings: [{ symbol: "AAPL.US", weight: 1 }, { symbol: "AAPL.US", weight: 2 }] },
    { holdingsDate: "2026-09-30", holdings: [{ symbol: "AAPL.US", weight: 1 }], extra: true },
  ]) {
    assert.equal((await request(`/${id}/snapshots`, "POST", body)).status, 400, JSON.stringify(body));
  }
  for (const body of [{ name: "   " }, { name: "x".repeat(201) }, {}, { name: "Ok", extra: 1 }]) {
    assert.equal((await request("/", "POST", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await request("/not-a-uuid")).status, 400);
  assert.equal((await request(`/${id}/snapshots/yesterday`, "DELETE")).status, 400);
  assert.equal(count("portfolio_snapshots"), 0);
});

test("a held symbol can't leave the registry, but can be disabled", async () => {
  const { sqlite, create } = setup();
  await create({ name: "Core", snapshot: september });

  assert.throws(() => sqlite.prepare(`DELETE FROM tracked_symbols WHERE symbol = 'AAPL.US'`).run(), /FOREIGN KEY/u);
  sqlite.prepare(`UPDATE tracked_symbols SET enabled = 0 WHERE symbol = 'AAPL.US'`).run();
});

test("forEngine loads the snapshots up to the as-of date", async () => {
  const { db, create } = setup();
  const { id } = await create({ name: "Core", snapshot: september });
  await Effect.runPromise(
    Portfolios.use((store) => store.addSnapshot(id, october, "2026-10-16T00:00:00.000Z")).pipe(
      Effect.provide(D1PortfoliosLive(db)),
    ),
  );

  const load = (asOf: string) =>
    Portfolios.use((store) => store.forEngine(id, asOf)).pipe(Effect.provide(D1PortfoliosLive(db)), Effect.runPromise);

  assert.deepEqual(await load("2026-10-14"), {
    id,
    name: "Core",
    snapshots: [
      { holdingsDate: "2026-09-30", holdings: [{ symbol: "AAPL.US", weight: 0.6 }, { symbol: "MSFT.US", weight: 0.4 }] },
    ],
  });
  assert.deepEqual((await load("2026-10-15")).snapshots.map((s) => s.holdingsDate), ["2026-09-30", "2026-10-15"]);
  assert.deepEqual((await load("2026-09-29")).snapshots, []);

  const missing = await Portfolios.use((store) => store.forEngine(crypto.randomUUID(), "2026-10-15")).pipe(
    Effect.provide(D1PortfoliosLive(db)),
    Effect.flip,
    Effect.runPromise,
  );
  assert.equal(missing.kind, "not_found");
});

test("database failures return a sanitized 500", async () => {
  const { request, sqlite } = setup();
  sqlite.close();
  const response = await request("/");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Could not access portfolios" });
});
