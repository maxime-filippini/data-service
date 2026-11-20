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
