import assert from "node:assert/strict";
import test from "node:test";

import type { LocalPlatformOptions } from "$/local/platform";
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "$/workflows/runs/contracts";
import { scheduledWorkflowTick } from "$/workflows/runs/dispatch";

import { assetPricesSpec, workflowService } from "./support/workflow-service";

/**
 * The workflow service with scheduled dispatch switched on, a controlled
 * clock for the hourly tick, and helpers to read runs through the API.
 */
const setup = (
  options: {
    readonly platform?: LocalPlatformOptions;
    readonly dispatch?: string;
    readonly limit?: number;
  } = {},
) => {
  const service = workflowService({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    env: { WORKFLOW_DISPATCH: options.dispatch ?? "on" },
  });
  const { api, json, dependencies, env } = service;

  /** One hourly tick at the given instant. */
  const tick = (at: string) =>
    scheduledWorkflowTick(
      dependencies,
      env,
      new Date(at),
      options.limit === undefined ? {} : { limit: options.limit },
    );
  /** Runs, oldest first. */
  const runs = async (query = "") =>
    (
      await json<{ runs: WorkflowRunSummary[] }>(api(`/runs${query}`))
    ).runs.toReversed();
  const detail = (runId: string) =>
    json<WorkflowRunDetail>(api(`/runs/${runId}`));
  /**
   * Runs as [symbol, trigger, occurrence, processing date, status], by
   * symbol, processing date and trigger (runs of one tick share a time).
   */
  const outcomes = async (query = "") =>
    (await runs(query))
      .map((run) => [
        run.subject.kind === "asset" ? run.subject.symbol : run.subject.id,
        run.trigger,
        run.scheduledFor,
        run.processingDate,
        run.status,
      ])
      .sort((a, b) =>
        [a[0], a[3], a[1]]
          .join(" ")
          .localeCompare([b[0], b[3], b[1]].join(" ")),
      );

  /** A definition at the hour, made the asset default, and assets created. */
  const configure = async (hourUtc: number, symbols: readonly string[]) => {
    const workflowId = await service.createWorkflow(assetPricesSpec(hourUtc));
    await json(api(`/workflow-defaults/asset/${workflowId}`, "PUT"));
    for (const symbol of symbols) await service.createAsset(symbol);
    return workflowId;
  };

  const startManual = (workflowId: string, symbol: string) =>
    json<WorkflowRunSummary>(
      api("/runs", "POST", {
        workflowId,
        subject: { kind: "asset", symbol },
        processingDate: "2024-01-10",
      }),
      202,
    );

  return {
    ...service,
    tick,
    runs,
    detail,
    outcomes,
    configure,
    startManual,
  };
};

test("the tick dispatches nothing unless WORKFLOW_DISPATCH is on", async () => {
  for (const dispatch of ["off", ""]) {
    const { configure, tick, runs } = setup({ dispatch });
    await configure(2, ["AAPL.US"]);
    assert.deepEqual(await tick("2024-01-10T03:00:00Z"), {
      status: "disabled",
    });
    assert.deepEqual(await runs(), []);
  }
});

test("each enabled assignment runs for the UTC date of the latest due occurrence", async () => {
  const { api, configure, tick, outcomes, runs, platform } = setup();
  await configure(2, ["AAPL.US", "MSFT.US"]);

  // Before 02:00 UTC the latest due occurrence is yesterday's.
  const early = await tick("2024-01-10T01:59:59Z");
  assert.equal(early.status, "dispatched");
  await platform.idle();
  assert.deepEqual(await outcomes(), [
    [
      "AAPL.US",
      "schedule",
      "2024-01-09T02:00:00.000Z",
      "2024-01-09",
      "completed",
    ],
    [
      "MSFT.US",
      "schedule",
      "2024-01-09T02:00:00.000Z",
      "2024-01-09",
      "completed",
    ],
  ]);

  // Exactly on the hour, today's occurrence is due.
  await tick("2024-01-10T02:00:00Z");
  await platform.idle();
  assert.deepEqual(
    (await outcomes()).filter((outcome) => outcome[3] === "2024-01-10"),
    [
      [
        "AAPL.US",
        "schedule",
        "2024-01-10T02:00:00.000Z",
        "2024-01-10",
        "completed",
      ],
      [
        "MSFT.US",
        "schedule",
        "2024-01-10T02:00:00.000Z",
        "2024-01-10",
        "completed",
      ],
    ],
  );

  // The processing date bounds the download, as for a manual run.
  const latest = (await runs()).find(
    (run) => run.processingDate === "2024-01-10",
  )!;
  const raw = (await (
    await api(`/runs/${latest.id}/steps/download/artifacts/raw`)
  ).json()) as { requestedRange: { to: string } };
  assert.equal(raw.requestedRange.to, "2024-01-10");
});

test("a late-evening schedule crosses the UTC date boundary correctly", async () => {
  const { configure, tick, outcomes } = setup({
    platform: { autoStart: false },
  });
  await configure(23, ["AAPL.US"]);

  // Ten past midnight: the latest occurrence was 23:00 the previous day.
  await tick("2024-01-10T00:10:00Z");
  assert.deepEqual(await outcomes(), [
    ["AAPL.US", "schedule", "2024-01-09T23:00:00.000Z", "2024-01-09", "queued"],
  ]);
});

test("repeated and concurrent ticks dispatch an assignment occurrence once", async () => {
  const { configure, tick, outcomes, platform } = setup({
    platform: { autoStart: false },
  });
  await configure(6, ["AAPL.US", "MSFT.US"]);

  await Promise.all([
    tick("2024-01-10T06:00:00Z"),
    tick("2024-01-10T06:00:00Z"),
    tick("2024-01-10T06:00:30Z"),
  ]);
  // Later ticks the same day find the occurrence already claimed.
  await tick("2024-01-10T07:00:00Z");
  await tick("2024-01-10T23:00:00Z");

  assert.deepEqual(await outcomes(), [
    ["AAPL.US", "schedule", "2024-01-10T06:00:00.000Z", "2024-01-10", "queued"],
    ["MSFT.US", "schedule", "2024-01-10T06:00:00.000Z", "2024-01-10", "queued"],
  ]);
  assert.equal(platform.instances.size, 2);
});

test("after downtime only the latest missed occurrence runs", async () => {
  const { configure, tick, outcomes, platform } = setup();
  await configure(6, ["AAPL.US"]);

  await tick("2024-01-05T06:00:00Z");
  await platform.idle();
  // No ticks for four days, then one mid-afternoon.
  const report = await tick("2024-01-10T15:00:00Z");
  await platform.idle();

  assert.deepEqual(await outcomes(), [
    [
      "AAPL.US",
      "schedule",
      "2024-01-05T06:00:00.000Z",
      "2024-01-05",
      "completed",
    ],
    [
      "AAPL.US",
      "schedule",
      "2024-01-10T06:00:00.000Z",
      "2024-01-10",
      "completed",
    ],
  ]);
  assert.equal(report.status === "dispatched" && report.runs.length, 1);
});

test("an occurrence overlapping an active run is recorded as skipped", async () => {
  const { configure, tick, outcomes, runs, platform } = setup({
    platform: { autoStart: false },
  });
  await configure(6, ["AAPL.US"]);

  await tick("2024-01-09T06:00:00Z");
  // The previous day's run is still going when the next occurrence is due.
  await tick("2024-01-10T06:00:00Z");
  await tick("2024-01-10T07:00:00Z");

  assert.deepEqual(await outcomes(), [
    ["AAPL.US", "schedule", "2024-01-09T06:00:00.000Z", "2024-01-09", "queued"],
    [
      "AAPL.US",
      "schedule",
      "2024-01-10T06:00:00.000Z",
      "2024-01-10",
      "skipped",
    ],
  ]);
  const [active, skipped] = await runs();
  assert.equal(
    skipped!.error,
    `Run ${active!.id} of this assignment was still queued`,
  );
  assert.equal(platform.instances.size, 1);

  // Skipped scheduled runs can be listed on their own.
  assert.deepEqual(
    (await runs("?trigger=schedule&status=skipped")).map((run) => run.id),
    [skipped!.id],
  );
});

test("manual and scheduled runs share the one-active-run rule", async () => {
  const { configure, tick, outcomes, startManual, platform } = setup({
    platform: { autoStart: false },
  });
  const workflowId = await configure(6, ["AAPL.US", "MSFT.US"]);

  // A manual run holds AAPL's slot: its occurrence is skipped, MSFT's runs.
  const manual = await startManual(workflowId, "AAPL.US");
  assert.equal(manual.status, "queued");
  await tick("2024-01-10T06:00:00Z");

  // A scheduled run holds MSFT's slot: a manual submission is skipped.
  const blocked = await startManual(workflowId, "MSFT.US");
  assert.equal(blocked.status, "skipped");

  assert.deepEqual(await outcomes(), [
    ["AAPL.US", "manual", null, "2024-01-10", "queued"],
    [
      "AAPL.US",
      "schedule",
      "2024-01-10T06:00:00.000Z",
      "2024-01-10",
      "skipped",
    ],
    ["MSFT.US", "manual", null, "2024-01-10", "skipped"],
    ["MSFT.US", "schedule", "2024-01-10T06:00:00.000Z", "2024-01-10", "queued"],
  ]);
  assert.equal(platform.instances.size, 2);
});

test("disabled definitions, assignments and assets are not dispatched", async () => {
  const { api, json, configure, tick, outcomes, platform } = setup();
  const workflowId = await configure(6, ["AAPL.US", "BRK-B.US", "MSFT.US"]);
  await json(
    api(`/workflows/${workflowId}/assignments/asset/AAPL.US`, "PATCH", {
      enabled: false,
    }),
  );
  await json(api("/assets/BRK-B.US", "PATCH", { enabled: false }));

  await tick("2024-01-10T06:00:00Z");
  await platform.idle();
  assert.deepEqual(await outcomes(), [
    [
      "MSFT.US",
      "schedule",
      "2024-01-10T06:00:00.000Z",
      "2024-01-10",
      "completed",
    ],
  ]);

  await json(
    api(`/workflows/${workflowId}`, "PUT", {
      ...assetPricesSpec(6),
      enabled: false,
    }),
  );
  await tick("2024-01-11T06:00:00Z");
  assert.equal((await outcomes()).length, 1);

  // Re-enabling catches up the latest occurrence, once.
  await json(api(`/workflows/${workflowId}`, "PUT", assetPricesSpec(6)));
  await json(
    api(`/workflows/${workflowId}/assignments/asset/AAPL.US`, "PATCH", {
      enabled: true,
    }),
  );
  await tick("2024-01-11T09:00:00Z");
  await tick("2024-01-11T10:00:00Z");
  await platform.idle();
  assert.deepEqual(
    (await outcomes()).filter((outcome) => outcome[3] === "2024-01-11"),
    [
      [
        "AAPL.US",
        "schedule",
        "2024-01-11T06:00:00.000Z",
        "2024-01-11",
        "completed",
      ],
      [
        "MSFT.US",
        "schedule",
        "2024-01-11T06:00:00.000Z",
        "2024-01-11",
        "completed",
      ],
    ],
  );
});

test("changing defaults changes what later assets are dispatched for, not earlier ones", async () => {
  const { api, json, createWorkflow, createAsset, configure, tick, outcomes } =
    setup({ platform: { autoStart: false } });
  const morning = await configure(6, ["AAPL.US"]);
  const evening = await createWorkflow(assetPricesSpec(18, "Evening"));
  assert.equal(
    (await api(`/workflow-defaults/asset/${morning}`, "DELETE")).status,
    204,
  );
  await json(api(`/workflow-defaults/asset/${evening}`, "PUT"));
  await createAsset("MSFT.US");

  await tick("2024-01-10T20:00:00Z");
  const dispatched = (await outcomes()).map(([symbol, , occurrence]) => [
    symbol,
    occurrence,
  ]);
  assert.deepEqual(dispatched, [
    ["AAPL.US", "2024-01-10T06:00:00.000Z"],
    ["MSFT.US", "2024-01-10T18:00:00.000Z"],
  ]);
});

test("each tick reconciles active runs whose launch was uncertain or whose instance stopped", async () => {
  const { configure, tick, detail, runs, platform, faults } = setup();
  await configure(6, ["AAPL.US"]);

  // The launch fails and its status can't be read: the claim holds.
  faults.create = "failed";
  faults.getUnavailable = true;
  await tick("2024-01-10T06:00:00Z");
  const [run] = await runs();
  assert.equal(run!.status, "queued");
  assert.equal(platform.instances.size, 0);

  // The next tick, with nothing new to dispatch, launches it under its ID.
  faults.create = "none";
  faults.getUnavailable = false;
  const report = await tick("2024-01-10T07:00:00Z");
  assert.equal(report.status === "dispatched" && report.runs.length, 0);
  await platform.idle();
  assert.equal((await detail(run!.id)).status, "completed");
  assert.deepEqual([...platform.instances.keys()], [run!.id]);
});

test("a run whose instance stopped without an outcome is failed by the next tick", async () => {
  const { configure, tick, detail, runs, platform } = setup({
    platform: { autoStart: false },
  });
  await configure(6, ["AAPL.US"]);
  await tick("2024-01-10T06:00:00Z");
  const [stuck] = await runs();
  platform.instances.get(stuck!.id)!.status = "errored";

  // Reconciled before dispatching, so the next occurrence is not skipped.
  await tick("2024-01-11T06:00:00Z");
  const failed = await detail(stuck!.id);
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.error,
    "The run's Workflow instance stopped (errored) without recording an outcome",
  );
  assert.equal(
    (await runs()).find((run) => run.processingDate === "2024-01-11")!.status,
    "queued",
  );
});

test("dispatch beyond the per-tick limit continues on the next tick for the same occurrence", async () => {
  const { configure, tick, outcomes } = setup({
    platform: { autoStart: false },
    limit: 2,
  });
  await configure(6, ["AAPL.US", "MSFT.US", "NVDA.US"]);

  await tick("2024-01-10T06:00:00Z");
  assert.equal((await outcomes()).length, 2);
  await tick("2024-01-10T07:00:00Z");
  assert.deepEqual(
    (await outcomes()).map(([symbol, , occurrence]) => [symbol, occurrence]),
    [
      ["AAPL.US", "2024-01-10T06:00:00.000Z"],
      ["MSFT.US", "2024-01-10T06:00:00.000Z"],
      ["NVDA.US", "2024-01-10T06:00:00.000Z"],
    ],
  );
});
