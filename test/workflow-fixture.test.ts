import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { PublicationView } from "$/datasets/contracts";
import { uvAvailable } from "$/local/python";
import type { WorkflowRunDetail } from "$/workflows/runs/contracts";

const run = promisify(execFile);

test(
  "the fixture command downloads, normalizes in Python and publishes, leaving inspectable files",
  {
    skip: uvAvailable()
      ? false
      : "uv is not installed, so the fixture command cannot start the Python service",
  },
  async () => {
    const out = mkdtempSync(join(tmpdir(), "workflow-fixture-"));
    try {
      await run(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/workflow-fixture.ts",
          "--out",
          out,
          "--symbol",
          "MSFT.US",
          "--date",
          "2024-01-05",
        ],
        { env: { ...process.env, EODHD_API_TOKEN: "" } },
      );

      const detail = JSON.parse(
        readFileSync(join(out, "run.json"), "utf8"),
      ) as WorkflowRunDetail;
      assert.equal(detail.status, "completed", detail.error ?? "");
      assert.deepEqual(detail.subject, { kind: "asset", symbol: "MSFT.US" });
      assert.deepEqual(
        detail.steps.map((step) => [step.id, step.status]),
        [
          ["download", "completed"],
          ["normalize", "completed"],
          ["publish", "completed"],
        ],
      );

      const runDirectory = join(
        out,
        "r2",
        "raw-market-data",
        "runs",
        detail.id,
      );
      const raw = JSON.parse(
        readFileSync(join(runDirectory, "download", "raw.json"), "utf8"),
      ) as { symbol: string; entries: { date: string }[] };
      assert.equal(raw.symbol, "MSFT.US");
      assert.equal(raw.entries.at(-1)!.date, "2024-01-05");
      // Written by Python into the directory both languages share.
      assert.ok(existsSync(join(runDirectory, "normalize", "prices.parquet")));

      const published = join(
        out,
        "r2",
        "processed-market-data",
        "dataset=prices_eod",
        "symbol=MSFT.US",
        "data.parquet",
      );
      assert.ok(existsSync(published));
      const publication = JSON.parse(
        readFileSync(join(out, "publication.json"), "utf8"),
      ) as PublicationView;
      assert.equal(publication.processingDate, "2024-01-05");
      assert.equal(publication.producer.runId, detail.id);
      assert.equal(publication.size, readFileSync(published).byteLength);

      assert.ok(existsSync(join(out, "d1.sqlite")));
      assert.match(
        readFileSync(join(out, "api.log"), "utf8"),
        /^POST \/api\/assets -> 201\n/u,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  },
);
