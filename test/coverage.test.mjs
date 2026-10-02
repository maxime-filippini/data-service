import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeDateRanges,
  subtractDateRanges,
} from "../src/market-data/coverage.ts";

test("mergeDateRanges merges overlapping and adjacent ranges", () => {
  assert.deepEqual(
    mergeDateRanges([
      { from: "2024-01-10", to: "2024-01-20" },
      { from: "2024-01-01", to: "2024-01-09" },
      { from: "2024-02-01", to: "2024-02-10" },
    ]),
    [
      { from: "2024-01-01", to: "2024-01-20" },
      { from: "2024-02-01", to: "2024-02-10" },
    ],
  );
});

test("subtractDateRanges returns only uncovered gaps", () => {
  assert.deepEqual(
    subtractDateRanges(
      { from: "2024-01-01", to: "2024-01-31" },
      [
        { from: "2023-12-01", to: "2024-01-05" },
        { from: "2024-01-10", to: "2024-01-20" },
        { from: "2024-01-25", to: "2024-02-10" },
      ],
    ),
    [
      { from: "2024-01-06", to: "2024-01-09" },
      { from: "2024-01-21", to: "2024-01-24" },
    ],
  );
});

test("subtractDateRanges returns nothing when the request is covered", () => {
  assert.deepEqual(
    subtractDateRanges(
      { from: "2024-06-01", to: "2024-06-30" },
      [{ from: "2024-01-01", to: "2024-12-31" }],
    ),
    [],
  );
});

test("subtractDateRanges returns the request when there is no coverage", () => {
  assert.deepEqual(
    subtractDateRanges(
      { from: "2024-06-01", to: "2024-06-30" },
      [],
    ),
    [{ from: "2024-06-01", to: "2024-06-30" }],
  );
});
