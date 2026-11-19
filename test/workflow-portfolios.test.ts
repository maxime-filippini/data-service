import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Schema } from "effect";

import type { Portfolio, Snapshot } from "$/portfolios/views";
import type { WorkflowAssignment } from "$/workflows/contracts";
import { defineStepType } from "$/workflows/registry";
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "$/workflows/runs/views";

import { workflowService } from "./support/workflow-service";

const september = {
  holdingsDate: "2024-09-30",
  holdings: [{ symbol: "AAPL.US", weight: 2 }],
};

const portfolioMarker = defineStepType({
  type: "portfolio-marker",
  description: "Fixture step to mark completion",
  scopes: ["portfolio"],
  params: Schema.Struct({}),
  inputs: {},
  outputs: {},
  implementation: () => Effect.succeed({}),
});

test("a portfolio snapshot can hold an asset created through the workflow API", async () => {
  const { api, json, createAsset } = workflowService();
  await createAsset("AAPL.US");

  const portfolio = await json<Portfolio>(
    api("/portfolios", "POST", { name: "Core", snapshot: september }),
    201,
  );
  assert.equal(portfolio.snapshots.length, 1);
  assert.deepEqual(portfolio.snapshots[0]?.holdings, september.holdings);

  const snapshot = await json<Snapshot>(
    api(`/portfolios/${portfolio.id}/snapshots/effective?date=2024-10-01`),
  );
  assert.deepEqual(snapshot, portfolio.snapshots[0]);
});

test("a holdings interval starts with the effective snapshot and includes changes through its end", async () => {
  const { api, json, createAsset } = workflowService();
  await createAsset("AAPL.US");
  await createAsset("MSFT.US", false);
  const { id } = await json<Portfolio>(
    api("/portfolios", "POST", { name: "Core", snapshot: september }),
    201,
  );
  const snapshots = `/portfolios/${id}/snapshots`;
  const october = {
    holdingsDate: "2024-10-15",
    holdings: [
      { symbol: "AAPL.US", weight: 3 },
      { symbol: "MSFT.US", weight: -0.5 },
    ],
  };
  await json(api(snapshots, "POST", october), 201);
  await json(
    api(snapshots, "POST", { ...october, holdingsDate: "2024-10-16" }),
    201,
  );

  await json(api(`${snapshots}/effective?date=2024-09-29`), 422);
  const effective = await json<Snapshot>(
    api(`${snapshots}/effective?date=2024-10-15`),
  );
  assert.equal(effective.holdingsDate, october.holdingsDate);
  assert.deepEqual(effective.holdings, october.holdings);

  const interval = (from: string, through: string) =>
    api(`${snapshots}?from=${from}&through=${through}`);
  const dates = async (from: string, through: string) =>
    (
      await json<{ snapshots: Snapshot[] }>(interval(from, through))
    ).snapshots.map((s) => s.holdingsDate);
  assert.deepEqual(await dates("2024-10-01", "2024-10-15"), [
    "2024-09-30",
    "2024-10-15",
  ]);
  assert.deepEqual(await dates("2024-10-15", "2024-10-15"), ["2024-10-15"]);
  assert.deepEqual(await dates("2024-09-01", "2024-10-01"), ["2024-09-30"]);
  assert.deepEqual(await dates("2024-09-01", "2024-09-29"), []);
  await json(interval("2024-10-15", "2024-10-01"), 400);
});

test("an asset appearing in an old snapshot cannot be deleted until that snapshot is removed", async () => {
  const { api, json, createAsset, createWorkflow } = workflowService();
  await createAsset("AAPL.US");
  await createAsset("MSFT.US");
  const workflowId = await createWorkflow();
  await json(
    api(`/workflows/${workflowId}/assignments`, "POST", {
      subject: { kind: "asset", symbol: "AAPL.US" },
    }),
    201,
  );
  const { id } = await json<Portfolio>(
    api("/portfolios", "POST", { name: "Core", snapshot: september }),
    201,
  );
  const snapshots = `/portfolios/${id}/snapshots`;
  await json(
    api(snapshots, "POST", {
      holdingsDate: "2024-10-15",
      holdings: [{ symbol: "MSFT.US", weight: 1 }],
    }),
    201,
  );

  const blocked = await json<{ error: string }>(
    api("/assets/AAPL.US", "DELETE"),
    409,
  );
  assert.match(blocked.error, /holdings/u);
  assert.equal(
    (
      await json<{ assignments: unknown[] }>(
        api(`/workflows/${workflowId}/assignments`),
      )
    ).assignments.length,
    1,
  );
  assert.equal(
    (await api(`${snapshots}/${september.holdingsDate}`, "DELETE")).status,
    204,
  );
  assert.equal((await api("/assets/AAPL.US", "DELETE")).status, 204);

  const missing = await json<{ symbols: string[] }>(
    api(snapshots, "POST", september),
    400,
  );
  assert.deepEqual(missing.symbols, ["AAPL.US"]);
  assert.deepEqual(
    (await json<Portfolio>(api(`/portfolios/${id}`))).snapshots.map(
      (s) => s.holdingsDate,
    ),
    ["2024-10-15"],
  );
});

test("new assets are also protected by pre-existing registry-backed holdings", async () => {
  const { api, json, createAsset, sqlite } = workflowService();
  sqlite
    .prepare(
      `INSERT INTO tracked_symbols
       (dataset, symbol, provider, enabled, backfill_start_date, created_at, updated_at)
     VALUES ('prices_eod', 'AAPL.US', 'eodhd', 1, '2016-01-01', '2024-01-01', '2024-01-01')`,
    )
    .run();
  const { id } = await json<Portfolio>(
    api("/portfolios", "POST", { name: "Existing", snapshot: september }),
    201,
  );
  await createAsset("AAPL.US");
  await createAsset("MSFT.US");
  await json(
    api(`/portfolios/${id}/snapshots`, "POST", {
      holdingsDate: "2024-10-15",
      holdings: [
        { symbol: "AAPL.US", weight: 0.5 },
        { symbol: "MSFT.US", weight: 0.5 },
      ],
    }),
    201,
  );

  await json(api("/assets/AAPL.US", "DELETE"), 409);
  assert.equal(
    (await api(`/portfolios/${id}/snapshots/2024-10-15`, "DELETE")).status,
    204,
  );
  await json(api("/assets/AAPL.US", "DELETE"), 409);
  assert.deepEqual(
    (await json<Portfolio>(api(`/portfolios/${id}`))).snapshots[0]?.holdings,
    september.holdings,
  );
  assert.equal((await api(`/portfolios/${id}`, "DELETE")).status, 204);
  assert.equal((await api("/assets/AAPL.US", "DELETE")).status, 204);
});

test("new portfolios get scoped defaults and deletion preserves completed history", async () => {
  const { api, json, createAsset, createWorkflow, platform, pages } =
    workflowService({
      extraStepTypes: [portfolioMarker],
      platform: { autoStart: false },
    });
  const assetWorkflow = await createWorkflow();
  const workflowId = await createWorkflow({
    name: "Dated portfolio",
    scope: "portfolio",
    enabled: true,
    schedule: { hourUtc: 7 },
    steps: [{ id: "mark", type: portfolioMarker.type, inputs: {} }],
  });
  const create = (name: string) =>
    json<Portfolio>(api("/portfolios", "POST", { name }), 201);
  const existing = await create("Existing");
  await json(api(`/workflow-defaults/portfolio/${workflowId}`, "PUT"));
  await json(api(`/workflow-defaults/asset/${assetWorkflow}`, "PUT"));
  const { id } = await create("New");
  const subject = { kind: "portfolio", id } as const;
  const assignments = (id: string) =>
    json<{ assignments: WorkflowAssignment[] }>(
      api(`/workflow-assignments?subjectKind=portfolio&subjectId=${id}`),
    ).then((body) => body.assignments);
  assert.deepEqual(await assignments(existing.id), []);
  assert.deepEqual(
    (await assignments(id)).map((a) => [a.workflowId, a.subject, a.schedule]),
    [[workflowId, subject, { hourUtc: 7 }]],
  );
  assert.deepEqual(await pages.portfolioDetail(id), {
    portfolio: await json(api(`/portfolios/${id}`)),
    assignments: await assignments(id),
  });
  await json(
    api(`/workflows/${assetWorkflow}/assignments`, "POST", { subject }),
    422,
  );
  await createAsset("AAPL.US");
  await json(
    api(`/workflows/${workflowId}/assignments`, "POST", {
      subject: { kind: "asset", symbol: "AAPL.US" },
    }),
    422,
  );

  const run = await json<WorkflowRunSummary>(
    api("/runs", "POST", { workflowId, subject }),
    202,
  );
  assert.equal(run.status, "queued");
  await json(api(`/portfolios/${id}`, "DELETE"), 409);
  assert.equal((await assignments(id)).length, 1);
  platform.start(run.id);
  await platform.idle();
  assert.equal((await api(`/portfolios/${id}`, "DELETE")).status, 204);
  assert.deepEqual(await assignments(id), []);
  const history = await json<WorkflowRunDetail>(api(`/runs/${run.id}`));
  assert.equal(history.status, "completed");
  assert.deepEqual(history.subject, subject);
  assert.equal(history.workflowName, "Dated portfolio");
});
