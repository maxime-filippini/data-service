import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { createMarketDataRoutes } from "$/routes/market-data";
import { makeEodEntry } from "./support/market-data-mocks";

const app = new Hono().route("/market-data", createMarketDataRoutes());
const path = "/market-data/eodhd?symbols=aapl.us,msft.us&from=2024-01-01&to=2024-01-03";
// The route runs without R2 or D1 bindings.
const bindings = { EODHD_API_TOKEN: "test-provider-token" };

test("direct EODHD HTTP contract", async (t) => {
  const urls: URL[] = [];
  const entries = [makeEodEntry("2024-01-02")];
  let upstream = (): Response => Response.json(entries);
  // Effect's fetch reference retains its default value. Keep one transport
  // for these sequential cases and vary its response instead of replacing it.
  t.mock.method(globalThis, "fetch", async (input: Request | URL | string) => {
    urls.push(new URL(input instanceof Request ? input.url : input.toString()));
    return upstream();
  });

  await t.test("mounted route fetches every request without storage", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.request(path, {}, bindings);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("Content-Type")!, /application\/json/);
      assert.deepEqual(await response.json(), { "AAPL.US": entries, "MSFT.US": entries });
    }
    assert.deepEqual(urls.map((url) => url.pathname), [
      "/api/eod/AAPL.US", "/api/eod/MSFT.US", "/api/eod/AAPL.US", "/api/eod/MSFT.US",
    ]);
    for (const url of urls) {
      assert.equal(url.origin, "https://eodhd.com");
      assert.equal(url.searchParams.get("api_token"), bindings.EODHD_API_TOKEN);
      assert.equal(url.searchParams.get("from"), "2024-01-01");
      assert.equal(url.searchParams.get("to"), "2024-01-03");
      assert.equal(url.searchParams.get("fmt"), "json");
    }
  });

  await t.test("invalid queries return 400 without fetching", async () => {
    const count = urls.length;
    for (const query of [
      "symbols=AAPL.US&from=2024-02-30&to=2024-03-01",
      "symbols=AAPL.US&from=2024-01-03&to=2024-01-01",
      "symbols=AAPL.US,AAPL.US&from=2024-01-01&to=2024-01-03",
      "from=2024-01-01&to=2024-01-03",
    ]) {
      assert.equal((await app.request(`/market-data/eodhd?${query}`, {}, bindings)).status, 400);
    }
    assert.equal(urls.length, count);
  });

  await t.test("missing token returns 500 without fetching", async () => {
    const count = urls.length;
    const response = await app.request(path, {}, { EODHD_API_TOKEN: "" });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "EODHD_API_TOKEN is missing or empty", symbol: null });
    assert.equal(urls.length, count);
  });

  await t.test("upstream failures return sanitized 502", async () => {
    for (const failure of [
      () => new Response("private provider error", { status: 503 }),
      () => Response.json([{ date: "invalid", close: "private provider value" }]),
      () => new Response("invalid json"),
      () => { throw new Error("private network error"); },
    ]) {
      upstream = failure;
      const count = urls.length;
      const response = await app.request(path, {}, bindings);
      assert.equal(response.status, 502);
      assert.equal(urls.length, count + 1);
      const body = await response.text();
      assert.equal(body.includes("private"), false);
      assert.equal(body.includes(bindings.EODHD_API_TOKEN), false);
      assert.equal(JSON.parse(body).symbol, "AAPL.US");
    }
  });

  await t.test("legacy paths are no longer mounted", async () => {
    const count = urls.length;
    for (const path of ["/market-data", "/market-data/market-data"]) {
      assert.equal((await app.request(path, {}, bindings)).status, 404);
    }
    assert.equal(urls.length, count);
  });
});
