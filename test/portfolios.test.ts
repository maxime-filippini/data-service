import assert from "node:assert/strict";
import test from "node:test";

import { requireManagementToken } from "$/auth";
import { D1PortfoliosLive } from "$/portfolios/d1";
import { createPortfolioRoutes } from "$/routes/portfolios";

import { makeTestDatabase } from "./support/d1";

const september = {
  holdingsDate: "2026-09-30",
  holdings: [
    { symbol: "MSFT.US", weight: 0.4 },
    { symbol: "AAPL.US", weight: 0.6 },
  ],
};

const october = {
  holdingsDate: "2026-10-15",
  holdings: [
    { symbol: "AAPL.US", weight: 1.5 },
    { symbol: "MSFT.US", weight: -0.5 },
  ],
};

interface PortfolioBody {
  id: string;
  name: string;
  updatedAt: string;
  snapshots: {
    holdingsDate: string;
    holdings: { symbol: string; weight: number }[];
  }[];
}

const setup = () => {
  const { sqlite, db } = makeTestDatabase();
  const seedAsset = (symbol: string, enabled = 1) =>
    sqlite
      .prepare(
        `INSERT INTO assets
           (symbol, provider, backfill_start_date, enabled, created_at, updated_at)
         VALUES (?, 'eodhd', '2016-01-01', ?, '2026-01-01', '2026-01-01')`,
      )
      .run(symbol, enabled);
  seedAsset("AAPL.US");
  seedAsset("MSFT.US", 0);

  const app = createPortfolioRoutes(
    () => D1PortfoliosLive(db),
    requireManagementToken,
  );
  const env = { MANAGEMENT_API_TOKEN: "management" } as CloudflareBindings;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    token = "management",
  ) =>
    app.request(
      path,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  const create = async (body: unknown) => {
    const response = await request("/", "POST", body);
    assert.equal(response.status, 201);
    return (await response.json()) as PortfolioBody;
  };
  const count = (table: string) =>
    (
      sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;
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
    [`/${id}/snapshots?from=2026-09-01&through=2026-09-30`, "GET"],
    [`/${id}/snapshots/effective?date=2026-09-30`, "GET"],
    [`/${id}/snapshots`, "POST"],
    [`/${id}/snapshots/2026-09-30`, "DELETE"],
  ] as const) {
    assert.equal(
      (await request(path, method, undefined, "wrong")).status,
      401,
      `${method} ${path}`,
    );
  }
});

test("create, list, rename and delete a portfolio", async () => {
  const { request, create, count } = setup();

  const empty = await create({ name: "  Growth  " });
  assert.equal(empty.name, "Growth");
  assert.deepEqual(empty.snapshots, []);

  const core = await create({ name: "Core", snapshot: september });
  assert.deepEqual(
    core.snapshots.map((s) => s.holdings),
    [
      [
        { symbol: "AAPL.US", weight: 0.6 },
        { symbol: "MSFT.US", weight: 0.4 },
      ],
    ],
  );
  assert.equal(count("portfolio_asset_holdings"), 2);
  assert.equal(count("portfolio_holdings"), 0);

  const list = (await (await request("/")).json()) as {
    portfolios: Record<string, unknown>[];
  };
  assert.deepEqual(
    list.portfolios.map(({ name, snapshotCount, latestHoldingsDate }) => ({
      name,
      snapshotCount,
      latestHoldingsDate,
    })),
    [
      { name: "Core", snapshotCount: 1, latestHoldingsDate: "2026-09-30" },
      { name: "Growth", snapshotCount: 0, latestHoldingsDate: null },
    ],
  );

  const renamed = await request(`/${core.id}`, "PATCH", {
    name: "Core equity",
  });
  assert.equal(renamed.status, 200);
  const body = (await renamed.json()) as PortfolioBody;
  assert.equal(body.name, "Core equity");
  assert.equal(body.snapshots.length, 1);

  assert.equal((await request(`/${core.id}`, "DELETE")).status, 204);
  assert.equal((await request(`/${core.id}`)).status, 404);
  assert.equal((await request(`/${core.id}`, "DELETE")).status, 404);
  assert.equal(
    (await request(`/${core.id}`, "PATCH", { name: "Gone" })).status,
    404,
  );
  assert.equal(count("portfolio_snapshots"), 0);
  assert.equal(count("portfolio_asset_holdings"), 0);
});

test("add and delete snapshots", async () => {
  const { request, create } = setup();
  const { id } = await create({ name: "Core", snapshot: october });

  const added = await request(`/${id}/snapshots`, "POST", september);
  assert.equal(added.status, 201);
  assert.equal(
    ((await added.json()) as { holdingsDate: string }).holdingsDate,
    "2026-09-30",
  );

  const portfolio = (await (await request(`/${id}`)).json()) as PortfolioBody;
  assert.deepEqual(
    portfolio.snapshots.map((s) => s.holdingsDate),
    ["2026-09-30", "2026-10-15"],
  );

  const duplicate = await request(`/${id}/snapshots`, "POST", september);
  assert.equal(duplicate.status, 409);

  assert.equal(
    (await request(`/${id}/snapshots/2026-09-30`, "DELETE")).status,
    204,
  );
  assert.equal(
    (await request(`/${id}/snapshots/2026-09-30`, "DELETE")).status,
    404,
  );
  const after = (await (await request(`/${id}`)).json()) as PortfolioBody;
  assert.deepEqual(
    after.snapshots.map((s) => s.holdingsDate),
    ["2026-10-15"],
  );

  assert.equal(
    (await request(`/${crypto.randomUUID()}/snapshots`, "POST", september))
      .status,
    404,
  );
});

test("retained legacy portfolio_holdings and single-asset portfolios remain readable and protected", async () => {
  const { sqlite, request } = setup();
  const legacyId = crypto.randomUUID();
  const singleId = crypto.randomUUID();

  sqlite
    .prepare(
      `INSERT INTO tracked_symbols VALUES ('prices_eod', 'NVDA.US', 'eodhd', 1, '2016-01-01', '2026-01-01', '2026-01-01')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO portfolios (portfolio_id, name, created_at, updated_at)
       VALUES (?, 'Pre-cutover', '2026-01-01', '2026-01-01')`,
    )
    .run(legacyId);
  sqlite
    .prepare(
      `INSERT INTO portfolio_snapshots (portfolio_id, holdings_date, created_at)
       VALUES (?, '2026-09-30', '2026-01-01')`,
    )
    .run(legacyId);
  sqlite
    .prepare(
      `INSERT INTO portfolio_holdings (portfolio_id, holdings_date, dataset, symbol, weight)
       VALUES (?, '2026-09-30', 'prices_eod', 'NVDA.US', 1)`,
    )
    .run(legacyId);

  const loaded = (await (
    await request(`/${legacyId}`)
  ).json()) as PortfolioBody;
  assert.deepEqual(
    loaded.snapshots.map(({ holdingsDate, holdings }) => ({
      holdingsDate,
      holdings,
    })),
    [
      {
        holdingsDate: "2026-09-30",
        holdings: [{ symbol: "NVDA.US", weight: 1 }],
      },
    ],
  );

  // Retained single-asset portfolio (asset_symbol non-null) remains immutable.
  sqlite
    .prepare(
      `INSERT INTO portfolios (portfolio_id, name, asset_symbol, created_at, updated_at)
       VALUES (?, 'NVDA.US', 'NVDA.US', '2026-01-01', '2026-01-01')`,
    )
    .run(singleId);
  sqlite
    .prepare(
      `INSERT INTO portfolio_snapshots (portfolio_id, holdings_date, created_at)
       VALUES (?, '1900-01-01', '2026-01-01')`,
    )
    .run(singleId);
  sqlite
    .prepare(
      `INSERT INTO portfolio_holdings (portfolio_id, holdings_date, dataset, symbol, weight)
       VALUES (?, '1900-01-01', 'prices_eod', 'NVDA.US', 1)`,
    )
    .run(singleId);

  for (const [path, method, body] of [
    [`/${singleId}`, "PATCH", { name: "Nvidia" }],
    [`/${singleId}`, "DELETE", undefined],
    [
      `/${singleId}/snapshots`,
      "POST",
      {
        holdingsDate: "2026-01-02",
        holdings: [{ symbol: "AAPL.US", weight: 1 }],
      },
    ],
    [`/${singleId}/snapshots/1900-01-01`, "DELETE", undefined],
  ] as const) {
    const response = await request(path, method, body);
    assert.equal(response.status, 409, `${method} ${path}`);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /single-asset portfolio of NVDA\.US/u,
    );
  }
});

test("snapshots only hold registered assets", async () => {
  const { request, create, count } = setup();
  const { id } = await create({ name: "Core" });

  const response = await request(`/${id}/snapshots`, "POST", {
    holdingsDate: "2026-09-30",
    holdings: [
      { symbol: "AAPL.US", weight: 1 },
      { symbol: "TSLA.US", weight: 1 },
      { symbol: "NVDA.US", weight: 1 },
    ],
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { symbols: string[] };
  assert.deepEqual([...body.symbols].sort(), ["NVDA.US", "TSLA.US"]);

  assert.equal(
    (
      await request("/", "POST", {
        name: "Bad",
        snapshot: {
          holdingsDate: "2026-09-30",
          holdings: [{ symbol: "TSLA.US", weight: 1 }],
        },
      })
    ).status,
    400,
  );
  assert.equal(count("portfolios"), 1);
  assert.equal(count("portfolio_snapshots"), 0);
});

test("deleting a portfolio still referenced by a historical table returns 409", async () => {
  const { sqlite, request, create } = setup();
  const { id } = await create({ name: "Referenced", snapshot: september });
  const calcId = crypto.randomUUID();
  sqlite
    .prepare(
      `INSERT INTO calculations
         (calculation_id, name, type, params_json, cron, enabled, created_at, updated_at)
       VALUES (?, 'Legacy vol', 'ex_ante_vol', '{}', '0 7 * * *', 0, '2026-01-01', '2026-01-01')`,
    )
    .run(calcId);
  sqlite
    .prepare(
      `INSERT INTO calculation_portfolios (calculation_id, portfolio_id, position)
       VALUES (?, ?, 0)`,
    )
    .run(calcId, id);

  const response = await request(`/${id}`, "DELETE");
  assert.equal(response.status, 409);
});

test("invalid input is rejected", async () => {
  const { request, create, count } = setup();
  const { id } = await create({ name: "Core" });

  for (const body of [
    {
      holdingsDate: "2026-09-31",
      holdings: [{ symbol: "AAPL.US", weight: 1 }],
    },
    { holdingsDate: "2026-09-30", holdings: [] },
    {
      holdingsDate: "2026-09-30",
      holdings: [{ symbol: "AAPL.US", weight: 0 }],
    },
    {
      holdingsDate: "2026-09-30",
      holdings: [{ symbol: "AAPL.US", weight: "1" }],
    },
    { holdingsDate: "2026-09-30", holdings: [{ symbol: "aapl", weight: 1 }] },
    {
      holdingsDate: "2026-09-30",
      holdings: [
        { symbol: "AAPL.US", weight: 1 },
        { symbol: "AAPL.US", weight: 2 },
      ],
    },
    {
      holdingsDate: "2026-09-30",
      holdings: [{ symbol: "AAPL.US", weight: 1 }],
      extra: true,
    },
  ]) {
    assert.equal(
      (await request(`/${id}/snapshots`, "POST", body)).status,
      400,
      JSON.stringify(body),
    );
  }
  for (const body of [
    { name: "   " },
    { name: "x".repeat(201) },
    {},
    { name: "Ok", extra: 1 },
  ]) {
    assert.equal(
      (await request("/", "POST", body)).status,
      400,
      JSON.stringify(body),
    );
  }
  assert.equal((await request("/not-a-uuid")).status, 400);
  assert.equal(
    (await request(`/${id}/snapshots/yesterday`, "DELETE")).status,
    400,
  );
  assert.equal(count("portfolio_snapshots"), 0);
});

test("database failures return a sanitized 500", async () => {
  const { request, sqlite } = setup();
  sqlite.close();
  const response = await request("/");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Could not access portfolios",
  });
});
