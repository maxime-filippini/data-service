import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowAssignment, WorkflowDefault } from "$/workflows/views";
import { scheduledWorkflowTick } from "$/workflows/runs/dispatch";
import { localSteps } from "$/local/steps";

import { assetPricesSpec, workflowService } from "./support/workflow-service";

const subjectsOf = (assignments: readonly WorkflowAssignment[]) =>
  assignments.map((assignment) =>
    assignment.subject.kind === "asset"
      ? assignment.subject.symbol
      : assignment.subject.id,
  );

test("default routes require the management token", async () => {
  const { api } = workflowService();
  const id = crypto.randomUUID();
  for (const [path, method] of [
    ["/workflow-defaults", "GET"],
    [`/workflow-defaults/asset/${id}`, "PUT"],
    [`/workflow-defaults/asset/${id}`, "DELETE"],
    ["/workflow-defaults/asset/apply", "POST"],
  ] as const)
    assert.equal(
      (await api(path, method, undefined, "wrong")).status,
      401,
      `${method} ${path}`,
    );
});

test("defaults are explicit per subject kind and only for a definition of that scope", async () => {
  const { api, json, createWorkflow } = workflowService();
  const prices = await createWorkflow(assetPricesSpec(6));

  assert.deepEqual(
    (await json<{ defaults: unknown[] }>(api("/workflow-defaults"))).defaults,
    [],
  );

  const added = await json<WorkflowDefault>(
    api(`/workflow-defaults/asset/${prices}`, "PUT"),
  );
  assert.equal(added.subjectKind, "asset");
  assert.equal(added.workflowId, prices);
  assert.equal(added.workflowName, "Daily asset prices");
  assert.deepEqual(added.schedule, { hourUtc: 6 });
  assert.equal(added.workflowEnabled, true);

  // Idempotent: adding it again changes nothing.
  assert.deepEqual(
    await json(api(`/workflow-defaults/asset/${prices}`, "PUT")),
    added,
  );
  assert.deepEqual(
    (await json<{ defaults: WorkflowDefault[] }>(api("/workflow-defaults")))
      .defaults,
    [added],
  );
  assert.deepEqual(
    (
      await json<{ defaults: WorkflowDefault[] }>(
        api("/workflow-defaults?subjectKind=portfolio"),
      )
    ).defaults,
    [],
  );

  // An asset workflow can't be a portfolio default; unknown definitions 404.
  const wrongKind = await json<{ error: string }>(
    api(`/workflow-defaults/portfolio/${prices}`, "PUT"),
    422,
  );
  assert.match(wrongKind.error, /asset workflow can't be a portfolio default/u);
  await json(
    api(`/workflow-defaults/asset/${crypto.randomUUID()}`, "PUT"),
    404,
  );

  const removed = await api(`/workflow-defaults/asset/${prices}`, "DELETE");
  assert.equal(removed.status, 204);
  await json(api(`/workflow-defaults/asset/${prices}`, "DELETE"), 404);
});

test("creating an asset assigns the asset defaults; changing defaults affects only later assets", async () => {
  const { api, json, createAsset, createWorkflow } = workflowService();
  const prices = await createWorkflow(assetPricesSpec(6, "Prices"));
  const extra = await createWorkflow(assetPricesSpec(9, "Extra"));
  await json(api(`/workflow-defaults/asset/${prices}`, "PUT"));

  await createAsset("AAPL.US");
  const assignments = (subject: string) =>
    json<{ assignments: WorkflowAssignment[] }>(
      api(`/workflows/${subject}/assignments`),
    ).then(({ assignments }) => assignments);
  assert.deepEqual(subjectsOf(await assignments(prices)), ["AAPL.US"]);
  const [first] = await assignments(prices);
  assert.equal(first!.enabled, true);
  assert.deepEqual(first!.schedule, { hourUtc: 6 });

  // A new default applies to later assets only; a removed one stops applying.
  await json(api(`/workflow-defaults/asset/${extra}`, "PUT"));
  assert.equal(
    (await api(`/workflow-defaults/asset/${prices}`, "DELETE")).status,
    204,
  );
  await createAsset("MSFT.US");
  assert.deepEqual(subjectsOf(await assignments(prices)), ["AAPL.US"]);
  assert.deepEqual(subjectsOf(await assignments(extra)), ["MSFT.US"]);

  // Creating an existing asset again assigns nothing.
  await json(
    api("/assets", "POST", {
      symbol: "AAPL.US",
      provider: "eodhd",
      backfillStartDate: "2016-01-01",
    }),
    409,
  );
  assert.deepEqual(subjectsOf(await assignments(extra)), ["MSFT.US"]);
});

test("applying defaults adds missing assignments idempotently and never re-enables a disabled one", async () => {
  const { api, json, createAsset, createWorkflow } = workflowService();
  await createAsset("AAPL.US");
  await createAsset("MSFT.US");
  await createAsset("NVDA.US", false);
  const prices = await createWorkflow();
  await json(api(`/workflow-defaults/asset/${prices}`, "PUT"));

  // Existing assets got nothing when the default was added.
  const list = () =>
    json<{ assignments: WorkflowAssignment[] }>(
      api(`/workflows/${prices}/assignments`),
    ).then(({ assignments }) => assignments);
  assert.deepEqual(await list(), []);

  await json(
    api(`/workflows/${prices}/assignments`, "POST", {
      subject: { kind: "asset", symbol: "MSFT.US" },
      enabled: false,
    }),
    201,
  );
  const applied = await json<{ added: WorkflowAssignment[] }>(
    api("/workflow-defaults/asset/apply", "POST"),
  );
  assert.deepEqual(subjectsOf(applied.added), ["AAPL.US", "NVDA.US"]);
  assert.deepEqual(
    (await list()).map((a) => [subjectsOf([a])[0], a.enabled]),
    [
      ["AAPL.US", true],
      ["MSFT.US", false],
      ["NVDA.US", true],
    ],
  );

  // Again: nothing to add, and the disabled assignment stays disabled.
  assert.deepEqual(
    (
      await json<{ added: WorkflowAssignment[] }>(
        api("/workflow-defaults/asset/apply", "POST"),
      )
    ).added,
    [],
  );
  assert.equal((await list())[1]!.enabled, false);
});

test("deleting a definition removes its default link but is blocked while a run is active", async () => {
  const { api, json, createAsset, createWorkflow } = workflowService({
    platform: { autoStart: false },
  });
  const prices = await createWorkflow();
  await json(api(`/workflow-defaults/asset/${prices}`, "PUT"));
  await createAsset("AAPL.US");
  await json(
    api("/runs", "POST", {
      workflowId: prices,
      subject: { kind: "asset", symbol: "AAPL.US" },
    }),
    202,
  );

  await json(api(`/workflows/${prices}`, "DELETE"), 409);
  assert.equal(
    (await json<{ defaults: unknown[] }>(api("/workflow-defaults"))).defaults
      .length,
    1,
  );
});

test("removing a definition removes it from the defaults", async () => {
  const { api, json, createAsset, createWorkflow } = workflowService();
  const prices = await createWorkflow();
  await json(api(`/workflow-defaults/asset/${prices}`, "PUT"));
  assert.equal((await api(`/workflows/${prices}`, "DELETE")).status, 204);
  assert.deepEqual(
    (await json<{ defaults: unknown[] }>(api("/workflow-defaults"))).defaults,
    [],
  );
  // A later asset gets no assignment from the deleted definition.
  await createAsset("AAPL.US");
  assert.deepEqual(
    (
      await json<{ assignments: unknown[] }>(
        api("/workflow-assignments?subjectKind=asset&subjectId=AAPL.US"),
      )
    ).assignments,
    [],
  );
});

test("the app's pages read the defaults, assigned schedules and scheduled outcomes", async () => {
  const { api, json, pages, createAsset, createWorkflow, dependencies, env } =
    workflowService({
      platform: { autoStart: false },
      env: { WORKFLOW_DISPATCH: "on" },
    });
  const prices = await createWorkflow(assetPricesSpec(6));
  const other = await createWorkflow(assetPricesSpec(9, "Other"));
  await json(api(`/workflow-defaults/asset/${prices}`, "PUT"));
  await createAsset("AAPL.US");

  const defaults = await pages.workflowDefaults();
  assert.deepEqual(
    defaults.map((entry) => [entry.subjectKind, entry.workflowName]),
    [["asset", "Daily asset prices"]],
  );
  assert.equal((await pages.workflow(prices)).isDefault, true);
  assert.equal((await pages.workflow(other)).isDefault, false);

  const asset = await pages.asset("AAPL.US");
  assert.deepEqual(
    asset.assignments.map((assignment) => [
      assignment.workflowName,
      assignment.schedule.hourUtc,
      assignment.workflowEnabled,
    ]),
    [["Daily asset prices", 6, true]],
  );

  // A dispatched occurrence and a manual run, told apart by trigger.
  await scheduledWorkflowTick(
    dependencies,
    env,
    new Date("2024-01-10T06:00:00Z"),
    localSteps(new Map(), { delayScale: 0 }),
  );
  await json(
    api("/runs", "POST", {
      workflowId: prices,
      subject: { kind: "asset", symbol: "AAPL.US" },
    }),
    202,
  );
  const scheduled = await pages.workflowRuns({ trigger: "schedule" });
  assert.deepEqual(
    scheduled.map((run) => [run.scheduledFor, run.status]),
    [["2024-01-10T06:00:00.000Z", "queued"]],
  );
  assert.deepEqual(
    (await pages.workflowRuns({ trigger: "manual" })).map((run) => run.status),
    ["skipped"],
  );
  assert.equal((await pages.workflowRuns({ trigger: "bogus" })).length, 2);
});
