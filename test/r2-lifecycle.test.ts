import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import { publishedDatasetKey } from "$/datasets/contracts";
import { runArtifactId } from "$/workflows/artifacts";

/** Retained pre-workflow raw-history key prefix in `raw-market-data`. */
const legacyRawMarketDataKey = (input: {
  readonly dataset: string;
  readonly symbol: string;
  readonly runId: string;
}) => `dataset=${input.dataset}/symbol=${input.symbol}/run=${input.runId}.json`;

/**
 * The checked-in lifecycle configuration for the raw buckets (applied with
 * `wrangler r2 bucket lifecycle set`; see the storage docs). These tests
 * check its scope and duration, not expiry itself: R2 applies the rule
 * asynchronously and nothing here waits 30 days.
 */
interface Rule {
  readonly id: string;
  readonly enabled: boolean;
  readonly conditions: { readonly prefix?: string };
  readonly deleteObjectsTransition?: {
    readonly condition: { readonly type: string; readonly maxAge?: number };
  };
  readonly [action: string]: unknown;
}

const { rules } = JSON.parse(
  readFileSync(
    new URL("../r2/raw-bucket-lifecycle.json", import.meta.url),
    "utf8",
  ),
) as { rules: Rule[] };

/** R2 selects a rule's objects by key prefix; no prefix selects everything. */
const expires = (key: string) =>
  rules.some(
    (rule) =>
      rule.enabled &&
      rule.deleteObjectsTransition !== undefined &&
      key.startsWith(rule.conditions.prefix ?? ""),
  );

const RUN_ID = "0b6c1f9e-5a2d-4c3b-9e8f-1a2b3c4d5e6f";

test("one rule expires temporary run artifacts 30 days after they are written", () => {
  assert.equal(rules.length, 1);
  const [rule] = rules;
  assert.equal(rule!.enabled, true);
  assert.deepEqual(rule!.conditions, { prefix: "runs/" });
  assert.deepEqual(rule!.deleteObjectsTransition, {
    condition: { type: "Age", maxAge: 30 * 24 * 60 * 60 },
  });
  // Nothing else: no storage-class transitions or multipart rules.
  assert.deepEqual(Object.keys(rule!).sort(), [
    "conditions",
    "deleteObjectsTransition",
    "enabled",
    "id",
  ]);
});

test("the rule covers every run artifact and nothing retained", () => {
  for (const format of ["json", "parquet"] as const)
    assert.ok(
      expires(
        runArtifactId({
          runId: RUN_ID,
          stepId: "normalize",
          name: "prices",
          format,
        }),
      ),
    );

  // Retained raw history from the pre-workflow downloader stays.
  assert.equal(
    expires(
      legacyRawMarketDataKey({
        dataset: "prices_eod",
        symbol: "AAPL.US",
        runId: RUN_ID,
      }),
    ),
    false,
  );
  // Published datasets live in the processed bucket, which has no rule; their
  // keys would not match the run prefix anyway.
  for (const subject of [
    { kind: "asset", symbol: "AAPL.US" },
    { kind: "portfolio", id: RUN_ID },
  ] as const)
    assert.equal(expires(publishedDatasetKey("prices_eod", subject)), false);
  // A symbol or dataset that merely starts with "runs" is not a run artifact.
  assert.equal(
    expires(
      legacyRawMarketDataKey({
        dataset: "prices_eod",
        symbol: "RUNS.US",
        runId: RUN_ID,
      }),
    ),
    false,
  );
});
