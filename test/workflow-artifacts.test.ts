import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { DatasetObjectStore } from "$/datasets/store";
import { memoryDatasetObjectStore } from "$/local/published";
import { MAX_SNAPSHOT_HOLDINGS } from "$/portfolios/contracts";
import type { Portfolio } from "$/portfolios/views";
import { MAX_STEP_OUTPUT_BYTES } from "$/workflows/executor";
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "$/workflows/runs/views";

import { workflowService } from "./support/workflow-service";

const DATE = "2024-01-07";
const STORED_AT = "2024-01-08T00:00:00.000Z";

const setup = async (count = 1, pause = false) => {
  const published = memoryDatasetObjectStore();
  const service = workflowService({
    published: published.layer,
    platform: {
      interruptBefore: (instance, name) =>
        pause &&
        instance.executions === 1 &&
        name === "start wait dependencies",
    },
  });
  const { api, json, sqlite, createWorkflow, artifacts, platform } = service;
  const holdings = Array.from({ length: count }, (_, index) => ({
    symbol: `S${String(index).padStart(5, "0")}.US`,
    weight: index + 0.5,
  }));
  const insertAsset = sqlite.prepare(
    `INSERT INTO assets VALUES (?, 'eodhd', '2024-01-01', 1, ?, ?)`,
  );
  for (const { symbol } of holdings)
    insertAsset.run(symbol, STORED_AT, STORED_AT);
  const portfolio = await json<Portfolio>(
    api("/portfolios", "POST", {
      name: "Artifact portfolio",
      snapshot: { holdingsDate: DATE, holdings },
    }),
    201,
  );
  const subject = { kind: "portfolio", id: portfolio.id } as const;
  const upstreamWorkflow = await createWorkflow();
  const workflowId = await createWorkflow({
    name: "Portfolio artifacts",
    scope: "portfolio",
    enabled: true,
    schedule: { hourUtc: 4 },
    steps: [
      {
        id: "holdings",
        type: "portfolio-holdings",
        inputs: {
          portfolio: { ref: "context.subject" },
          processingDate: { ref: "context.processingDate" },
        },
      },
      {
        id: "dependencies",
        type: "wait-for-asset-publications",
        params: { workflowId: upstreamWorkflow },
        inputs: {
          holdings: { ref: "steps.holdings.outputs.holdings" },
          processingDate: { ref: "context.processingDate" },
        },
      },
    ],
  });
  await json(
    api(`/workflows/${workflowId}/assignments`, "POST", { subject }),
    201,
  );

  // Seed completed upstream runs and their matching objects/metadata. The
  // cross-language tests exercise producing these through the asset workflow.
  const seedPublications = async () => {
    const insertRun = sqlite.prepare(
      `INSERT INTO workflow_runs
       (run_id, workflow_id, workflow_name, subject_kind, subject_id,
        processing_date, trigger, status, steps_json, created_at, finished_at)
       VALUES (?, ?, 'Asset prices', 'asset', ?, ?, 'manual', 'completed', '[]', ?, ?)`,
    );
    const insertPublication = sqlite.prepare(
      `INSERT INTO dataset_publications
       (dataset, subject_kind, subject_id, processing_date, workflow_id, run_id,
        step_id, source_artifact, format, schema, etag, size, published_at)
       VALUES ('prices_eod', 'asset', ?, ?, ?, ?, 'publish', ?, 'parquet', 'prices-eod/v1', ?, ?, ?)`,
    );
    for (const { symbol } of holdings) {
      const runId = crypto.randomUUID();
      const { etag, size } = await Effect.runPromise(
        DatasetObjectStore.use((objects) =>
          objects.put(
            `dataset=prices_eod/symbol=${symbol}/data.parquet`,
            new Uint8Array([1, 2, 3]),
            "application/vnd.apache.parquet",
          ),
        ).pipe(Effect.provide(published.layer)),
      );
      insertRun.run(
        runId,
        upstreamWorkflow,
        symbol,
        DATE,
        STORED_AT,
        STORED_AT,
      );
      insertPublication.run(
        symbol,
        DATE,
        upstreamWorkflow,
        runId,
        `runs/${runId}/normalize/prices.parquet`,
        etag,
        size,
        STORED_AT,
      );
    }
  };
  const runDetail = (id: string) => json<WorkflowRunDetail>(api(`/runs/${id}`));
  const start = async () => {
    const run = await json<WorkflowRunSummary>(
      api("/runs", "POST", {
        workflowId,
        subject,
        processingDate: DATE,
      }),
      202,
    );
    await platform.idle();
    return runDetail(run.id);
  };
  return { ...service, holdings, subject, seedPublications, start, runDetail };
};

test("a maximum-size portfolio checkpoints only references and exposes both complete artifacts", async () => {
  const service = await setup(MAX_SNAPSHOT_HOLDINGS);
  await service.seedPublications();
  const run = await service.start();
  assert.equal(run.status, "completed", run.error ?? "");
  for (const step of run.steps)
    assert.ok(
      Buffer.byteLength(JSON.stringify(step.outputs)) < MAX_STEP_OUTPUT_BYTES,
    );

  const holdings = await service.json<{ holdings: unknown[] }>(
    service.api(`/runs/${run.id}/steps/holdings/artifacts/holdings`),
  );
  assert.deepEqual(holdings.holdings, service.holdings);
  const publications = await service.json<{ subject: { symbol: string } }[]>(
    service.api(`/runs/${run.id}/steps/dependencies/artifacts/publications`),
  );
  assert.deepEqual(
    publications.map(({ subject }) => subject.symbol),
    service.holdings.map(({ symbol }) => symbol),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(holdings)) > MAX_STEP_OUTPUT_BYTES,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(publications)) > MAX_STEP_OUTPUT_BYTES,
  );
  // No large arrays leak into the durable checkpoints either.
  for (const value of service.platform.instances
    .get(run.id)!
    .checkpoints.values())
    assert.ok(Buffer.byteLength(value) < MAX_STEP_OUTPUT_BYTES);
});

test("repeating the holdings step after a lost checkpoint reuses its existing artifact", async () => {
  const service = await setup(1, true);
  await service.seedPublications();
  const run = await service.start();
  const artifactId = `runs/${run.id}/holdings/holdings.json`;
  const before = service.artifacts.objects.get(artifactId);
  // The object write succeeded, but its step checkpoint was lost.
  assert.equal(
    service.platform.instances.get(run.id)!.checkpoints.delete("step holdings"),
    true,
  );
  service.sqlite
    .prepare(
      "UPDATE portfolio_asset_holdings SET weight = 99 WHERE portfolio_id = ?",
    )
    .run(service.subject.id);
  service.platform.replay(run.id);
  await service.platform.idle();
  const resumed = await service.runDetail(run.id);
  assert.equal(resumed.status, "completed", resumed.error ?? "");
  assert.equal(resumed.steps[0]?.attempts, 2);
  assert.equal(service.artifacts.objects.get(artifactId), before);
  assert.deepEqual(resumed.steps[0]?.outputs, run.steps[0]?.outputs);
});

for (const scenario of [
  "missing",
  "invalid-json",
  "invalid-schema",
  "wrong-portfolio",
  "wrong-date",
  "oversized",
] as const) {
  test(`${scenario} holdings data fails without loading newer portfolio state`, async () => {
    const service = await setup(1, true);
    const run = await service.start();
    const artifactId = `runs/${run.id}/holdings/holdings.json`;
    const valid = JSON.parse(String(service.artifacts.objects.get(artifactId)));
    if (scenario === "missing") service.artifacts.objects.delete(artifactId);
    else
      service.artifacts.objects.set(
        artifactId,
        scenario === "invalid-json"
          ? "{"
          : scenario === "invalid-schema"
            ? JSON.stringify({ ...valid, holdings: [] })
            : scenario === "wrong-portfolio"
              ? JSON.stringify({
                  ...valid,
                  portfolio: { kind: "portfolio", id: crypto.randomUUID() },
                })
              : scenario === "wrong-date"
                ? JSON.stringify({ ...valid, processingDate: "2024-01-06" })
                : " ".repeat(8 * 1024 * 1024 + 1),
      );
    service.platform.replay(run.id);
    await service.platform.idle();
    const failed = await service.runDetail(run.id);
    assert.equal(failed.status, "failed");
    assert.match(
      failed.error ?? "",
      scenario === "missing"
        ? /artifact no longer exists/u
        : scenario === "invalid-json"
          ? /not valid JSON/u
          : scenario === "invalid-schema"
            ? /does not match portfolio-holdings\/v1/u
            : scenario === "oversized"
              ? /exceeds/u
              : /does not match the portfolio and processing date/u,
    );
    assert.equal(failed.steps[1]?.status, "failed");
    assert.equal(service.platform.instances.size, 1);
    if (scenario === "missing")
      await service.json(
        service.api(`/runs/${run.id}/steps/holdings/artifacts/holdings`),
        404,
      );
  });
}
