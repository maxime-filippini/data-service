import assert from "node:assert/strict";
import test from "node:test";

import { makeEodEntry, makeMarketDataTestHarness } from "./support/market-data-mocks";

test("every request fetches the full range for each symbol", async () => {
  const entries = [makeEodEntry("2024-01-02"), makeEodEntry("2024-01-03")];
  const harness = makeMarketDataTestHarness({ providerEntries: entries });
  const request = { symbols: ["AAPL.US", "MSFT.US"], from: "2024-01-01", to: "2024-01-03" } as const;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await harness.retrieve(request), { "AAPL.US": entries, "MSFT.US": entries });
  }
  assert.deepEqual(harness.sourceRequests, [
    { symbol: "AAPL.US", range: { from: request.from, to: request.to } },
    { symbol: "MSFT.US", range: { from: request.from, to: request.to } },
    { symbol: "AAPL.US", range: { from: request.from, to: request.to } },
    { symbol: "MSFT.US", range: { from: request.from, to: request.to } },
  ]);
});

test("an empty provider response remains an empty JSON array", async () => {
  const harness = makeMarketDataTestHarness({ providerEntries: [] });
  assert.deepEqual(await harness.retrieve({
    symbols: ["AAPL.US"], from: "2024-01-01", to: "2024-01-01",
  }), { "AAPL.US": [] });
});
