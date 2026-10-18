import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";

import { MarketDataSource } from "$/market-data";
import { EodhdMarketDataSourceLive } from "$/market-data/eodhd";

const retrieve = (token: unknown) =>
  MarketDataSource.use((source) =>
    source.retrieveDaily("AAPL.US", { from: "2024-01-01", to: "2024-01-03" }),
  ).pipe(Effect.provide(EodhdMarketDataSourceLive(token)), Effect.result, Effect.runPromise);

test("EODHD adapter", async (t) => {
  const urls: URL[] = [];
  let upstream = (): Response => Response.json([]);
  // Effect captures fetch once, so keep one mock and vary its response.
  t.mock.method(globalThis, "fetch", async (input: Request | URL | string) => {
    urls.push(new URL(input instanceof Request ? input.url : input.toString()));
    return upstream();
  });

  await t.test("fetches the symbol range and validates entries", async () => {
    const entries = [{ date: "2024-01-02", open: 1, close: 2, high: 3, low: 0.5, adjusted_close: 2, volume: 10 }];
    upstream = () => Response.json(entries);
    const result = await retrieve("token");
    assert.equal(result._tag, "Success");
    assert.deepEqual(result._tag === "Success" ? result.success : undefined, entries);

    const url = urls.at(-1)!;
    assert.equal(url.origin + url.pathname, "https://eodhd.com/api/eod/AAPL.US");
    assert.equal(url.searchParams.get("api_token"), "token");
    assert.equal(url.searchParams.get("from"), "2024-01-01");
    assert.equal(url.searchParams.get("to"), "2024-01-03");
  });

  await t.test("rejects malformed responses and upstream errors", async () => {
    upstream = () => Response.json([{ date: "nope" }]);
    const malformed = await retrieve("token");
    assert.equal(malformed._tag === "Failure" && malformed.failure.kind, "response");

    upstream = () => new Response("down", { status: 503 });
    const failed = await retrieve("token");
    assert.equal(failed._tag === "Failure" && failed.failure.kind, "request");
  });

  await t.test("requires a token", async () => {
    const calls = urls.length;
    const result = await retrieve("  ");
    assert.equal(result._tag === "Failure" && result.failure.kind, "configuration");
    assert.equal(urls.length, calls);
  });
});
