import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { WorkflowRunDetail } from "$/workflows/runs/contracts";

const run = promisify(execFile);

test("the fixture command runs the download workflow and leaves inspectable artifacts", async () => {
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
    assert.equal(detail.status, "completed");
    assert.deepEqual(detail.subject, { kind: "asset", symbol: "MSFT.US" });
    const raw = JSON.parse(
      readFileSync(
        join(out, "r2", "runs", detail.id, "download", "raw.json"),
        "utf8",
      ),
    ) as { symbol: string; entries: { date: string }[] };
    assert.equal(raw.symbol, "MSFT.US");
    assert.equal(raw.entries.at(-1)!.date, "2024-01-05");
    assert.ok(existsSync(join(out, "d1.sqlite")));
    assert.match(
      readFileSync(join(out, "api.log"), "utf8"),
      /^POST \/api\/assets -> 201\n/u,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
