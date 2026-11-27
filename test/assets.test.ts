import assert from "node:assert/strict";
import test from "node:test";

import { requireManagementToken } from "$/auth";
import { D1AssetStoreLive } from "$/assets/d1";
import { createAssetRoutes } from "$/routes/assets";

import { makeTestDatabase } from "./support/d1";

const setup = () => {
  const { sqlite, db } = makeTestDatabase();
  const app = createAssetRoutes(
    () => D1AssetStoreLive(db),
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
  const count = (table: string) =>
    (
      sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;
  return { sqlite, request, count };
};

const apple = {
  symbol: "AAPL.US",
  provider: "eodhd",
  backfillStartDate: "2016-01-01",
};

test("every asset route requires the management token", async () => {
  const { request } = setup();
  for (const [path, method] of [
    ["/", "GET"],
    ["/", "POST"],
    ["/AAPL.US", "GET"],
    ["/AAPL.US", "PATCH"],
    ["/AAPL.US", "DELETE"],
  ] as const) {
    assert.equal(
      (await request(path, method, undefined, "wrong")).status,
      401,
      `${method} ${path}`,
    );
  }
});

test("create, list, get, edit, disable and delete an asset by symbol", async () => {
  const { request, count } = setup();

  const created = await request("/", "POST", apple);
  assert.equal(created.status, 201);
  const body = (await created.json()) as Record<string, unknown>;
  assert.deepEqual(
    { ...body, createdAt: undefined, updatedAt: undefined },
    {
      symbol: "AAPL.US",
      provider: "eodhd",
      backfillStartDate: "2016-01-01",
      enabled: true,
      createdAt: undefined,
      updatedAt: undefined,
    },
  );
  assert.equal("dataset" in body, false);
  // Creating an asset creates no synthetic single-asset portfolio.
  assert.equal(count("portfolios"), 0);

  // Provider-qualified symbols are kept as given.
  assert.equal(
    (
      await request("/", "POST", {
        ...apple,
        symbol: "BRK-B.US",
        enabled: false,
      })
    ).status,
    201,
  );

  const list = (await (await request("/")).json()) as {
    assets: { symbol: string; enabled: boolean }[];
  };
  assert.deepEqual(
    list.assets.map(({ symbol, enabled }) => ({ symbol, enabled })),
    [
      { symbol: "AAPL.US", enabled: true },
      { symbol: "BRK-B.US", enabled: false },
    ],
  );

  const edited = await request("/AAPL.US", "PATCH", {
    backfillStartDate: "2010-01-04",
    enabled: false,
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(
    await (await request("/AAPL.US")).json().then((asset) => {
      const { backfillStartDate, enabled } = asset as Record<string, unknown>;
      return { backfillStartDate, enabled };
    }),
    { backfillStartDate: "2010-01-04", enabled: false },
  );

  assert.equal((await request("/AAPL.US", "DELETE")).status, 204);
  assert.equal((await request("/AAPL.US")).status, 404);
  assert.equal((await request("/AAPL.US", "DELETE")).status, 404);
  assert.equal(count("assets"), 1);
});

test("an existing symbol cannot be created twice", async () => {
  const { request } = setup();
  assert.equal((await request("/", "POST", apple)).status, 201);
  const again = await request("/", "POST", apple);
  assert.equal(again.status, 409);
});

test("asset input is validated", async () => {
  const { request } = setup();
  for (const body of [
    { ...apple, symbol: "aapl.us" },
    { ...apple, provider: "yahoo" },
    { ...apple, backfillStartDate: "2016-02-30" },
    { ...apple, backfillStartDate: "2999-01-01" },
    { ...apple, dataset: "prices_eod" },
  ]) {
    assert.equal(
      (await request("/", "POST", body)).status,
      400,
      JSON.stringify(body),
    );
  }
  assert.equal((await request("/", "POST", apple)).status, 201);
  assert.equal(
    (await request("/AAPL.US", "PATCH", { symbol: "MSFT.US" })).status,
    400,
  );
  assert.equal(
    (await request("/MSFT.US", "PATCH", { enabled: false })).status,
    404,
  );
});

test("an edit keeps the fields it omits", async () => {
  const { request } = setup();
  await request("/", "POST", apple);
  const edited = await request("/AAPL.US", "PATCH", { enabled: false });
  assert.equal(edited.status, 200);
  const { createdAt, updatedAt, ...asset } = (await edited.json()) as Record<
    string,
    unknown
  >;
  assert.deepEqual(asset, { ...apple, enabled: false });
  assert.ok(typeof createdAt === "string" && typeof updatedAt === "string");
  assert.equal(
    (await request("/MSFT.US", "PATCH", { enabled: false })).status,
    404,
  );
});

/** An asset workflow that is an asset default. */
const addAssetDefault = (sqlite: ReturnType<typeof setup>["sqlite"]) => {
  sqlite.exec(`INSERT INTO workflow_definitions
      (workflow_id, name, scope, enabled, schedule_hour_utc, steps_json, created_at, updated_at)
    VALUES ('prices', 'Prices', 'asset', 1, 6, '[]', 'then', 'then');
    INSERT INTO workflow_defaults (subject_kind, workflow_id, created_at)
    VALUES ('asset', 'prices', 'then');`);
};

test("creating an asset assigns the asset defaults, and a duplicate assigns nothing", async () => {
  const { sqlite, request, count } = setup();
  addAssetDefault(sqlite);
  await request("/", "POST", apple);
  assert.deepEqual(
    sqlite
      .prepare(
        `SELECT workflow_id, subject_kind, subject_id, enabled FROM workflow_assignments`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        workflow_id: "prices",
        subject_kind: "asset",
        subject_id: "AAPL.US",
        enabled: 1,
      },
    ],
  );

  // With the assignment removed, a rejected duplicate does not restore it.
  sqlite.exec(`DELETE FROM workflow_assignments`);
  assert.equal((await request("/", "POST", apple)).status, 409);
  assert.equal(count("workflow_assignments"), 0);
});

test("an asset with an active run is kept until the run finishes", async () => {
  const { sqlite, request, count } = setup();
  addAssetDefault(sqlite);
  await request("/", "POST", apple);
  sqlite.exec(`INSERT INTO workflow_runs
      (run_id, workflow_id, workflow_name, subject_kind, subject_id, processing_date,
       trigger, status, steps_json, created_at)
    VALUES ('run-1', 'prices', 'Prices', 'asset', 'AAPL.US', '2024-01-02',
       'manual', 'waiting', '[]', 'then')`);

  const refused = await request("/AAPL.US", "DELETE");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error:
      "Run run-1 for asset AAPL.US is still active; delete the asset once it finishes",
  });
  assert.equal(count("assets"), 1);
  assert.equal(count("workflow_assignments"), 1);

  sqlite.exec(`UPDATE workflow_runs SET status = 'completed'`);
  assert.equal((await request("/AAPL.US", "DELETE")).status, 204);
  assert.equal(count("assets"), 0);
  assert.equal(count("workflow_assignments"), 0);
  // Run history is not touched.
  assert.equal(count("workflow_runs"), 1);
});
