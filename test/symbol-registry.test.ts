import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { URL } from "node:url";

import { requireManagementToken } from "$/auth";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { createSymbolRoutes } from "$/routes/symbols";
import { makeTestDatabase } from "./support/d1";

const aapl = { dataset: "prices_eod", symbol: "AAPL.US", provider: "eodhd", backfillStartDate: "2016-01-01" };

const setup = () => {
  const { sqlite, db } = makeTestDatabase();
  const app = createSymbolRoutes(() => D1SymbolRegistryLive(db), requireManagementToken);
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
  return { sqlite, request };
};

test("every route requires the management token", async () => {
  const { request } = setup();
  for (const [path, method] of [["/", "GET"], ["/", "POST"], ["/prices_eod/AAPL.US/disable", "POST"], ["/prices_eod/AAPL.US/enable", "POST"]] as const) {
    assert.equal((await request(path, method, method === "POST" ? aapl : undefined, "wrong")).status, 401);
  }
});

test("register, update, and take a symbol off and back on the schedule", async () => {
  const { request } = setup();

  const created = await request("/", "POST", aapl);
  assert.equal(created.status, 201);
  const first = (await created.json()) as Record<string, unknown>;
  assert.equal(first.enabled, true);

  const updated = await request("/", "POST", { ...aapl, backfillStartDate: "2010-01-01" });
  assert.equal(updated.status, 200);
  const second = (await updated.json()) as Record<string, unknown>;
  assert.equal(second.backfillStartDate, "2010-01-01");
  assert.equal(second.createdAt, first.createdAt);

  const disabled = await request("/prices_eod/AAPL.US/disable", "POST");
  assert.equal(disabled.status, 200);
  assert.equal(((await disabled.json()) as Record<string, unknown>).enabled, false);

  const enabled = await request("/prices_eod/AAPL.US/enable", "POST");
  assert.equal(enabled.status, 200);
  const third = (await enabled.json()) as Record<string, unknown>;
  assert.equal(third.enabled, true);
  assert.equal(third.backfillStartDate, "2010-01-01");

  await request("/prices_eod/AAPL.US/disable", "POST");
  const reenabled = await request("/", "POST", aapl);
  assert.equal(((await reenabled.json()) as Record<string, unknown>).enabled, true);

  assert.equal((await request("/prices_eod/MSFT.US/disable", "POST")).status, 404);
  assert.equal((await request("/prices_eod/MSFT.US/enable", "POST")).status, 404);
});

test("list filters by dataset and enabled", async () => {
  const { request } = setup();
  await request("/", "POST", aapl);
  await request("/", "POST", { ...aapl, symbol: "MSFT.US", enabled: false });

  const symbolsOf = async (query: string) =>
    ((await (await request(`/${query}`)).json()) as { symbols: { symbol: string }[] }).symbols.map((s) => s.symbol);

  assert.deepEqual(await symbolsOf(""), ["AAPL.US", "MSFT.US"]);
  assert.deepEqual(await symbolsOf("?enabled=true"), ["AAPL.US"]);
  assert.deepEqual(await symbolsOf("?enabled=false&dataset=prices_eod"), ["MSFT.US"]);
  assert.equal((await request("/?dataset=unknown")).status, 400);
});

test("registration rejects invalid input", async () => {
  const { request, sqlite } = setup();
  for (const body of [
    { ...aapl, symbol: "aapl" },
    { ...aapl, dataset: "rates" },
    { ...aapl, provider: "fred" },
    { ...aapl, backfillStartDate: "2016-02-30" },
    { ...aapl, backfillStartDate: "2999-01-01" },
    { ...aapl, extra: true },
    { dataset: "prices_eod", symbol: "AAPL.US" },
  ]) {
    assert.equal((await request("/", "POST", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM tracked_symbols").get() as { n: number }).n, 0);
});

test("database failures return a sanitized 500", async () => {
  const { request, sqlite } = setup();
  sqlite.close();
  const response = await request("/");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Could not access the symbol registry" });
});

const singleAssetPortfolios = (sqlite: ReturnType<typeof makeTestDatabase>["sqlite"]) =>
  sqlite
    .prepare(
      `SELECT p.name, p.asset_symbol, h.holdings_date, h.symbol, h.weight
       FROM portfolios p JOIN portfolio_holdings h USING (portfolio_id)
       WHERE p.asset_symbol IS NOT NULL
       ORDER BY p.name`,
    )
    .all()
    .map((row) => ({ ...row }));

test("registering a symbol creates its single-asset portfolio once", async () => {
  const { request, sqlite } = setup();
  await request("/", "POST", aapl);
  await request("/", "POST", { ...aapl, backfillStartDate: "2010-01-01" });
  await request("/prices_eod/AAPL.US/disable", "POST");
  await request("/", "POST", { ...aapl, symbol: "MSFT.US", enabled: false });

  assert.deepEqual(singleAssetPortfolios(sqlite), [
    { name: "AAPL.US", asset_symbol: "AAPL.US", holdings_date: "1900-01-01", symbol: "AAPL.US", weight: 1 },
    { name: "MSFT.US", asset_symbol: "MSFT.US", holdings_date: "1900-01-01", symbol: "MSFT.US", weight: 1 },
  ]);
  const [{ id }] = sqlite.prepare(`SELECT portfolio_id AS id FROM portfolios WHERE asset_symbol = 'AAPL.US'`).all() as {
    id: string;
  }[];
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test("the migration gives every registered prices_eod symbol a single-asset portfolio", () => {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
  const apply = (file: string) => sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  const backfill = "0008_single_asset_portfolios.sql";
  files.filter((file) => file < backfill).forEach(apply);
  for (const symbol of ["AAPL.US", "MSFT.US"]) {
    sqlite
      .prepare(`INSERT INTO tracked_symbols VALUES ('prices_eod', ?, 'eodhd', 1, '2016-01-01', '2026-01-01', '2026-01-01')`)
      .run(symbol);
  }
  sqlite.prepare(`INSERT INTO portfolios VALUES (?, 'Core', '2026-09-01', '2026-09-01')`).run(crypto.randomUUID());
  apply(backfill);

  assert.deepEqual(singleAssetPortfolios(sqlite), [
    { name: "AAPL.US", asset_symbol: "AAPL.US", holdings_date: "1900-01-01", symbol: "AAPL.US", weight: 1 },
    { name: "MSFT.US", asset_symbol: "MSFT.US", holdings_date: "1900-01-01", symbol: "MSFT.US", weight: 1 },
  ]);
  for (const { id } of sqlite.prepare(`SELECT portfolio_id AS id FROM portfolios`).all() as { id: string }[]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  }
});
