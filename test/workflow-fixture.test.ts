import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { PublicationView } from "$/datasets/contracts";
import { uvAvailable } from "$/local/python";
import type { Portfolio } from "$/portfolios/views";
import type { WorkflowRunDetail } from "$/workflows/runs/views";

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

      const portfolio = JSON.parse(
        readFileSync(join(out, "portfolio.json"), "utf8"),
      ) as Portfolio;
      assert.deepEqual(
        portfolio.snapshots.map(({ holdingsDate, holdings }) => ({
          holdingsDate,
          holdings,
        })),
        [
          {
            holdingsDate: "2024-01-04",
            holdings: [
              { symbol: "AAPL.US", weight: 0.25 },
              { symbol: "MSFT.US", weight: 0.75 },
            ],
          },
          {
            holdingsDate: "2024-01-05",
            holdings: [
              { symbol: "AAPL.US", weight: 0.25 },
              { symbol: "MSFT.US", weight: 1.25 },
            ],
          },
        ],
      );
      const portfolioRun = JSON.parse(
        readFileSync(join(out, "portfolio-run.json"), "utf8"),
      ) as WorkflowRunDetail;
      assert.equal(portfolioRun.status, "completed", portfolioRun.error ?? "");
      assert.deepEqual(portfolioRun.subject, {
        kind: "portfolio",
        id: portfolio.id,
      });
      const calculation = portfolioRun.steps.find(
        ({ id }) => id === "volatility",
      );
      assert.equal(calculation?.status, "completed");
      const { volatility, ...summary } = calculation.outputs?.summary as {
        volatility: number;
      };
      // Sample standard deviation of the Jan 3/4/5 weighted returns times sqrt(252).
      assert.ok(Math.abs(volatility - 0.16655193949753938) < 1e-12);
      assert.deepEqual(summary, {
        observations: 3,
        windowStart: "2024-01-03",
        windowEnd: "2024-01-05",
        holdingsDate: "2024-01-05",
      });
      const assetRuns = JSON.parse(
        readFileSync(join(out, "asset-runs.json"), "utf8"),
      ) as WorkflowRunDetail[];
      assert.deepEqual(
        assetRuns.map(({ subject, status }) => [subject, status]),
        [
          [{ kind: "asset", symbol: "MSFT.US" }, "completed"],
          [{ kind: "asset", symbol: "AAPL.US" }, "completed"],
        ],
      );
      const readRunArtifact = (output: unknown) =>
        JSON.parse(
          readFileSync(
            join(out, "r2", "raw-market-data", (output as { id: string }).id),
            "utf8",
          ),
        ) as unknown;
      assert.deepEqual(
        readRunArtifact(portfolioRun.steps[0]?.outputs?.holdings),
        {
          portfolio: portfolioRun.subject,
          processingDate: portfolioRun.processingDate,
          holdingsDate: "2024-01-05",
          holdings: portfolio.snapshots[1]?.holdings,
        },
      );
      assert.deepEqual(
        readRunArtifact(portfolioRun.steps[1]?.outputs?.publications),
        [...assetRuns].reverse().map((upstream) => ({
          dataset: "prices_eod",
          subject: upstream.subject,
          processingDate: upstream.processingDate,
          workflowId: upstream.workflowId,
          runId: upstream.id,
        })),
      );
      const volatilityPublication = JSON.parse(
        readFileSync(join(out, "portfolio-publication.json"), "utf8"),
      ) as PublicationView;
      assert.equal(volatilityPublication.dataset, "portfolio_volatility");
      assert.equal(volatilityPublication.producer.runId, portfolioRun.id);
      const volatilityPath = join(
        out,
        "r2",
        "processed-market-data",
        "dataset=portfolio_volatility",
        `portfolio=${portfolio.id}`,
        "data.parquet",
      );
      assert.equal(
        volatilityPublication.size,
        readFileSync(volatilityPath).byteLength,
      );

      assert.ok(existsSync(join(out, "d1.sqlite")));
      assert.match(
        readFileSync(join(out, "api.log"), "utf8"),
        /^POST \/api\/workflows -> 201\nPUT \/api\/workflow-defaults\/asset\/[0-9a-f-]+ -> 200\nPOST \/api\/assets -> 201\n/u,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  },
);

test(
  "the fixture command can dispatch the default assignment through the scheduled tick",
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
          "--date",
          "2024-01-08",
          "--scheduled",
        ],
        { env: { ...process.env, EODHD_API_TOKEN: "" } },
      );

      const detail = JSON.parse(
        readFileSync(join(out, "run.json"), "utf8"),
      ) as WorkflowRunDetail;
      assert.equal(detail.status, "completed", detail.error ?? "");
      assert.equal(detail.trigger, "schedule");
      assert.equal(detail.scheduledFor, "2024-01-08T02:00:00.000Z");
      assert.equal(detail.processingDate, "2024-01-08");
      assert.match(
        readFileSync(join(out, "api.log"), "utf8"),
        /tick 2024-01-08T03:00:00Z -> run [0-9a-f-]+ \(queued\)\n/u,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  },
);
