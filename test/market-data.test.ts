import assert from "node:assert/strict";
import test from "node:test";

import {
  makeEodEntry,
  makeMarketDataTestHarness,
} from "./support/market-data-mocks";

test("a range after cached coverage fetches the entire requested range", async () => {
  const harness = makeMarketDataTestHarness({
    coverage: [{ from: "2024-01-01", to: "2024-01-05" }],
    cachedEntries: [],
    providerEntries: [
      makeEodEntry("2024-01-10"),
      makeEodEntry("2024-01-11"),
      makeEodEntry("2024-01-12"),
    ],
  });

  const result = await harness.retrieve({
    symbols: ["AAPL.US"],
    from: "2024-01-10",
    to: "2024-01-12",
    force: false,
  });

  assert.deepEqual(
    {
      requestedRanges: harness.sourceRequests.map(({ range }) => range),
      returnedDates: result["AAPL.US"].map(({ date }) => date),
      storedCoverage: harness.storeRequests.flatMap(({ coverage }) => coverage),
    },
    {
      requestedRanges: [{ from: "2024-01-10", to: "2024-01-12" }],
      returnedDates: ["2024-01-10", "2024-01-11", "2024-01-12"],
      storedCoverage: [{ from: "2024-01-10", to: "2024-01-12" }],
    },
  );
});

test("partial coverage fetches only the gaps around the cached range", async () => {
  const harness = makeMarketDataTestHarness({
    coverage: [{ from: "2024-01-03", to: "2024-01-05" }],
    cachedEntries: [
      makeEodEntry("2024-01-03"),
      makeEodEntry("2024-01-04"),
      makeEodEntry("2024-01-05"),
    ],
    providerEntries: [
      makeEodEntry("2024-01-01"),
      makeEodEntry("2024-01-02"),
      makeEodEntry("2024-01-06"),
      makeEodEntry("2024-01-07"),
    ],
  });

  const result = await harness.retrieve({
    symbols: ["AAPL.US"],
    from: "2024-01-01",
    to: "2024-01-07",
    force: false,
  });

  assert.deepEqual(
    {
      requestedRanges: harness.sourceRequests.map(({ range }) => range),
      returnedDates: result["AAPL.US"].map(({ date }) => date),
      storedCoverage: harness.storeRequests.flatMap(({ coverage }) => coverage),
    },
    {
      requestedRanges: [
        { from: "2024-01-01", to: "2024-01-02" },
        { from: "2024-01-06", to: "2024-01-07" },
      ],
      returnedDates: [
        "2024-01-01",
        "2024-01-02",
        "2024-01-03",
        "2024-01-04",
        "2024-01-05",
        "2024-01-06",
        "2024-01-07",
      ],
      storedCoverage: [
        { from: "2024-01-01", to: "2024-01-02" },
        { from: "2024-01-06", to: "2024-01-07" },
      ],
    },
  );
});

test("complete coverage returns cached entries without calling the provider", async () => {
  const cachedEntries = [
    makeEodEntry("2024-01-01"),
    makeEodEntry("2024-01-02"),
    makeEodEntry("2024-01-03"),
  ];
  const harness = makeMarketDataTestHarness({
    coverage: [{ from: "2024-01-01", to: "2024-01-03" }],
    cachedEntries,
    providerEntries: [],
  });

  const result = await harness.retrieve({
    symbols: ["AAPL.US"],
    from: "2024-01-01",
    to: "2024-01-03",
    force: false,
  });

  assert.deepEqual(
    {
      requestedRanges: harness.sourceRequests.map(({ range }) => range),
      returnedDates: result["AAPL.US"].map(({ date }) => date),
    },
    {
      requestedRanges: [],
      returnedDates: ["2024-01-01", "2024-01-02", "2024-01-03"],
    },
  );
});
