import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

import { utcDay } from "$/datetime";
import { memoryRunArtifacts } from "$/local/artifacts";
import { fixtureSourceFor, loadEodhdFixtures } from "$/local/eodhd-fixtures";
import type { LocalPlatformOptions } from "$/local/platform";
import { localWorkflowService } from "$/local/runs";
import { pageData, PageDataError } from "$/pages";
import { createRoutes } from "$/routes";
import {
  dateContract,
  defineContract,
  defineStepType,
  rawPricesEodContract,
  type StepType,
} from "$/workflows/registry";
import type { RunPlatform } from "$/workflows/runs/contracts";
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "$/workflows/runs/views";

import { makeTestDatabase } from "./support/d1";

const TOKEN = "management-token";

const fixtures = loadEodhdFixtures(
  fileURLToPath(new URL("../fixtures/eodhd/", import.meta.url).href),
);

/** A test-only contract for plain text outputs. */
const text = defineContract({
  id: "test-text",
  description: "Text",
  schema: Schema.String,
});

/** Test-only step combining a prior output, the run context and a literal. */
const describeDownload = defineStepType({
  type: "describe-download",
  description: "Describe a raw download",
  scopes: ["asset"],
  params: Schema.Struct({}),
  inputs: {
    raw: { contract: rawPricesEodContract, description: "Raw prices" },
    date: { contract: dateContract, description: "A date" },
    label: { contract: text, description: "A label" },
  },
  outputs: { summary: { contract: text, description: "The summary" } },
  implementation: ({ inputs }) =>
    Effect.succeed({
      summary: `${inputs.label} ${inputs.date} ${inputs.raw.id}`,
    }),
});

/** Test-only step whose output is too large to checkpoint. */
const oversized = defineStepType({
  type: "oversized",
  description: "Return a large output",
  scopes: ["asset"],
  params: Schema.Struct({}),
  inputs: {},
  outputs: { blob: { contract: text, description: "Too much text" } },
  implementation: () => Effect.succeed({ blob: "x".repeat(40_000) }),
});

const download = (params: Record<string, unknown> = {}) => ({
  id: "download",
  type: "download-prices",
  params: { startDate: "2024-01-01", ...params },
  inputs: {
    asset: { ref: "context.subject" },
    throughDate: { ref: "context.processingDate" },
  },
});

const assetPrices = (steps: unknown[] = [download()]) => ({
  name: "Daily asset prices",
  scope: "asset",
  enabled: true,
  schedule: { hourUtc: 2 },
  steps,
});

const setup = (
  options: {
    readonly extraStepTypes?: readonly StepType[];
    readonly platform?: LocalPlatformOptions;
  } = {},
) => {
  const { sqlite, db } = makeTestDatabase();
  const requests: URL[] = [];
  /** Override a provider response; undefined answers from fixtures. */
  const provider: { respond: (url: URL) => Response | undefined } = {
    respond: () => undefined,
  };
  const artifacts = memoryRunArtifacts();
  const service = localWorkflowService({
    db,
    artifacts: artifacts.layer,
    sourceFor: fixtureSourceFor(fixtures, (url) => {
      requests.push(url);
      return provider.respond(url);
    }),
    extraStepTypes: [
      describeDownload,
      oversized,
      ...(options.extraStepTypes ?? []),
    ],
    platform: { steps: { delayScale: 0 }, ...options.platform },
  });
  const platform = service.platform;

  /** Faults injected between the API and the Workflow binding. */
  const faults = {
    /** "lost": the instance is created but the response is lost. */
    create: "none" as "none" | "lost" | "failed",
    getUnavailable: false,
  };
  const runPlatform: RunPlatform = {
    create: async (create) => {
      if (faults.create === "failed") throw new Error("network error");
      const instance = await platform.create(create);
      if (faults.create === "lost") throw new Error("response lost");
      return instance;
    },
    get: async (id) => {
      if (faults.getUnavailable) throw new Error("platform unavailable");
      return platform.get(id);
    },
  };

  const dependencies = {
    ...service.dependencies,
    runPlatformFor: () => runPlatform,
  };
  const routes = createRoutes(dependencies, {
    fetch: () => new Response("app"),
  });
  const env = { MANAGEMENT_API_TOKEN: TOKEN } as CloudflareBindings;
  const api = (path: string, method = "GET", body?: unknown, token = TOKEN) =>
    routes.request(
      `https://data-service.example.com/api${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  const json = async <T = Record<string, unknown>>(
    response: Response | Promise<Response>,
    status = 200,
  ) => {
    const resolved = await response;
    const body = (await resolved.json()) as T;
    assert.equal(resolved.status, status, JSON.stringify(body));
    return body;
  };

  /** Create the asset, the definition and its assignment through the API. */
  const configure = async (
    spec: unknown = assetPrices(),
    symbol = "AAPL.US",
  ) => {
    await json(
      api("/assets", "POST", {
        symbol,
        provider: "eodhd",
        backfillStartDate: "2016-01-01",
      }),
      201,
    );
    const { id } = await json<{ id: string }>(
      api("/workflows", "POST", spec),
      201,
    );
    await json(
      api(`/workflows/${id}/assignments`, "POST", {
        subject: { kind: "asset", symbol },
      }),
      201,
    );
    return id;
  };

  const start = (
    workflowId: string,
    extra: Record<string, unknown> = {},
    symbol = "AAPL.US",
  ) =>
    api("/runs", "POST", {
      workflowId,
      subject: { kind: "asset", symbol },
      ...extra,
    });
  const started = (response: Response | Promise<Response>) =>
    json<WorkflowRunSummary>(response, 202);
  const detail = (runId: string) =>
    json<WorkflowRunDetail>(api(`/runs/${runId}`));
  const artifact = async (runId: string, step = "download", output = "raw") => {
    const response = await api(
      `/runs/${runId}/steps/${step}/artifacts/${output}`,
    );
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as {
      runId: string;
      provider: string;
      symbol: string;
      requestedRange: { from: string; to: string };
      entries: { date: string }[];
    };
  };

  return {
    sqlite,
    api,
    json,
    configure,
    start,
    started,
    detail,
    artifact,
    platform,
    faults,
    provider,
    requests,
    artifacts,
    pages: pageData({} as CloudflareBindings, dependencies),
  };
};

test("run routes require the management token", async () => {
  const { api } = setup();
  const id = crypto.randomUUID();
  for (const [path, method] of [
    ["/runs", "GET"],
    ["/runs", "POST"],
    [`/runs/${id}`, "GET"],
    [`/runs/${id}/rerun`, "POST"],
    [`/runs/${id}/steps/download/artifacts/raw`, "GET"],
  ] as const)
    assert.equal(
      (await api(path, method, undefined, "wrong")).status,
      401,
      `${method} ${path}`,
    );
});

test("a manual run downloads fixture prices for today and keeps the raw artifact under the run", async () => {
  const { configure, start, started, detail, artifact, platform, requests } =
    setup();
  const workflowId = await configure();

  const run = await started(start(workflowId));
  const today = utcDay(new Date());
  assert.equal(run.status, "queued");
  assert.equal(run.processingDate, today);
  assert.equal(run.workflowName, "Daily asset prices");
  assert.deepEqual(run.subject, { kind: "asset", symbol: "AAPL.US" });

  await platform.idle();
  const finished = await detail(run.id);
  assert.equal(finished.status, "completed", finished.error ?? "");
  assert.equal(finished.steps.length, 1);
  const [step] = finished.steps;
  assert.equal(step!.status, "completed");
  assert.equal(step!.attempts, 1);
  assert.deepEqual(step!.outputs, {
    raw: {
      id: `runs/${run.id}/download/raw.json`,
      format: "json",
      schema: "raw-prices-eod/v1",
    },
  });

  // The real EODHD adapter built the request; fixtures answered it.
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.pathname, "/api/eod/AAPL.US");
  assert.equal(requests[0]!.searchParams.get("from"), "2024-01-01");
  assert.equal(requests[0]!.searchParams.get("to"), today);

  const raw = await artifact(run.id);
  assert.equal(raw.runId, run.id);
  assert.equal(raw.provider, "eodhd");
  assert.equal(raw.symbol, "AAPL.US");
  assert.deepEqual(raw.requestedRange, { from: "2024-01-01", to: today });
  assert.equal(raw.entries.length, 9);
});

test("the processing date can be given and bounds the download", async () => {
  const { configure, start, started, json, detail, artifact, platform } =
    setup();
  const workflowId = await configure();

  await json(start(workflowId, { processingDate: "2024-02-30" }), 400);

  const run = await started(
    start(workflowId, { processingDate: "2024-01-05" }),
  );
  assert.equal(run.processingDate, "2024-01-05");
  await platform.idle();
  assert.equal((await detail(run.id)).status, "completed");
  const raw = await artifact(run.id);
  assert.deepEqual(
    raw.entries.map((entry) => entry.date),
    ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"],
  );
});

test("manual runs require an enabled definition, assignment and asset", async () => {
  const { api, json, configure, start } = setup();
  const workflowId = await configure();
  const assignment = `/workflows/${workflowId}/assignments/asset/AAPL.US`;

  await json(start(crypto.randomUUID()), 404);
  await json(
    api("/assets", "POST", {
      symbol: "MSFT.US",
      provider: "eodhd",
      backfillStartDate: "2016-01-01",
    }),
    201,
  );
  await json(start(workflowId, {}, "MSFT.US"), 404);

  await json(api(assignment, "PATCH", { enabled: false }));
  const disabledAssignment = await json<{ error: string }>(
    start(workflowId),
    409,
  );
  assert.match(disabledAssignment.error, /assignment .* is disabled/u);
  await json(api(assignment, "PATCH", { enabled: true }));

  await json(api("/assets/AAPL.US", "PATCH", { enabled: false }));
  assert.match(
    (await json<{ error: string }>(start(workflowId), 409)).error,
    /asset AAPL\.US is disabled/u,
  );
  await json(api("/assets/AAPL.US", "PATCH", { enabled: true }));

  await json(
    api(`/workflows/${workflowId}`, "PUT", {
      ...assetPrices(),
      enabled: false,
    }),
  );
  assert.match(
    (await json<{ error: string }>(start(workflowId), 409)).error,
    /definition is disabled/u,
  );

  // Nothing was recorded for the rejected submissions.
  assert.deepEqual((await json<{ runs: unknown[] }>(api("/runs"))).runs, []);
});

test("a rerun is a new run of the same assignment and date from the beginning", async () => {
  const { api, configure, start, started, detail, platform, requests } =
    setup();
  const workflowId = await configure();
  const first = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  await platform.idle();

  const second = await started(api(`/runs/${first.id}/rerun`, "POST"));
  assert.notEqual(second.id, first.id);
  assert.equal(second.rerunOf, first.id);
  assert.equal(second.processingDate, "2024-01-10");
  await platform.idle();

  const rerun = await detail(second.id);
  assert.equal(rerun.status, "completed");
  assert.equal(rerun.steps[0]!.attempts, 1);
  // The download ran again rather than reusing the first run's output.
  assert.equal(requests.length, 2);
  assert.equal(
    (rerun.steps[0]!.outputs!.raw as { id: string }).id,
    `runs/${second.id}/download/raw.json`,
  );
});

test("an overlapping submission is recorded as skipped while a run is active", async () => {
  const { api, json, configure, start, started, detail, platform } = setup({
    platform: { autoStart: false },
  });
  const workflowId = await configure();

  const [a, b] = await Promise.all([
    started(start(workflowId)),
    started(start(workflowId)),
  ]);
  const [active, other] = a.status === "queued" ? [a, b] : [b, a];
  assert.equal(active.status, "queued");
  assert.equal(other.status, "skipped");
  assert.match(
    other.error ?? "",
    new RegExp(`Run ${active.id} .* still queued`, "u"),
  );

  const later = await started(
    start(workflowId, { processingDate: "2024-01-05" }),
  );
  assert.equal(later.status, "skipped");
  assert.equal(platform.instances.size, 1);

  // A skipped run never ran: its steps are skipped.
  assert.deepEqual(
    (await detail(later.id)).steps.map((step) => step.status),
    ["skipped"],
  );

  platform.start(active.id);
  await platform.idle();
  assert.equal((await detail(active.id)).status, "completed");
  assert.equal((await started(start(workflowId))).status, "queued");

  const skipped = await json<{ runs: WorkflowRunSummary[] }>(
    api(`/runs?workflowId=${workflowId}&status=skipped`),
  );
  assert.deepEqual(
    skipped.runs.map((run) => run.id).sort(),
    [other.id, later.id].sort(),
  );
});

test("an active run keeps the definition captured when it was claimed", async () => {
  const { api, json, configure, start, started, detail, artifact, platform } =
    setup({ platform: { autoStart: false } });
  const workflowId = await configure();
  const run = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );

  await json(
    api(`/workflows/${workflowId}`, "PUT", {
      ...assetPrices([download({ startDate: "2024-01-08" })]),
      name: "Renamed",
    }),
  );
  platform.start(run.id);
  await platform.idle();

  const finished = await detail(run.id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.workflowName, "Daily asset prices");
  assert.equal((await artifact(run.id)).requestedRange.from, "2024-01-01");

  // The next run observes the replacement.
  const next = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  assert.equal(next.workflowName, "Renamed");
  platform.start(next.id);
  await platform.idle();
  assert.equal((await artifact(next.id)).requestedRange.from, "2024-01-08");
});

test("a replayed run reuses checkpointed step outputs instead of downloading again", async () => {
  const { configure, start, started, detail, platform, requests } = setup({
    platform: {
      // Evict the first execution just before it records completion.
      interruptBefore: (instance, step) =>
        instance.executions === 1 && step === "complete run",
    },
  });
  const workflowId = await configure();
  const run = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  await platform.idle();

  const interrupted = await detail(run.id);
  assert.equal(interrupted.status, "running");
  assert.equal(interrupted.steps[0]!.status, "completed");
  assert.equal(requests.length, 1);

  platform.replay(run.id);
  await platform.idle();
  const finished = await detail(run.id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.steps[0]!.attempts, 1);
  assert.equal(requests.length, 1);
  assert.equal(platform.instances.get(run.id)!.executions, 2);
});

test("transient provider failures are retried three times with backoff before the run fails", async () => {
  const { configure, start, started, detail, platform, provider, requests } =
    setup();
  const workflowId = await configure();

  let outages = 2;
  provider.respond = () =>
    outages-- > 0 ? new Response("unavailable", { status: 503 }) : undefined;
  const recovered = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  await platform.idle();
  const ok = await detail(recovered.id);
  assert.equal(ok.status, "completed");
  assert.equal(ok.steps[0]!.attempts, 3);
  assert.equal(ok.steps[0]!.error, null);
  assert.equal(requests.length, 3);

  provider.respond = () => new Response("unavailable", { status: 503 });
  const failing = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  await platform.idle();
  const failed = await detail(failing.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.steps[0]!.status, "failed");
  // One attempt and three retries.
  assert.equal(failed.steps[0]!.attempts, 4);
  assert.equal(
    failed.error,
    'Step "download" failed: The EODHD request failed',
  );
  assert.equal(failed.steps[0]!.error, "The EODHD request failed");
});

test("invalid provider data fails the run at once without storing it", async () => {
  const { configure, start, started, detail, platform, provider, artifacts } =
    setup();
  const workflowId = await configure();
  provider.respond = () => Response.json([{ date: "not a date" }]);

  const run = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  await platform.idle();
  const failed = await detail(run.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.steps[0]!.attempts, 1);
  assert.equal(
    failed.error,
    'Step "download" failed: EODHD returned data that did not match its schema',
  );
  assert.equal(artifacts.objects.size, 0);
});

test("steps resolve literals, run context and earlier outputs", async () => {
  const { configure, start, started, detail, platform } = setup();
  const workflowId = await configure(
    assetPrices([
      download(),
      {
        id: "describe",
        type: "describe-download",
        inputs: {
          raw: { ref: "steps.download.outputs.raw" },
          date: { ref: "context.processingDate" },
          label: { value: "fetched" },
        },
      },
    ]),
  );
  const run = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  await platform.idle();

  const finished = await detail(run.id);
  assert.equal(finished.status, "completed", finished.error ?? "");
  assert.deepEqual(
    finished.steps.map((step) => [step.position, step.id, step.status]),
    [
      [1, "download", "completed"],
      [2, "describe", "completed"],
    ],
  );
  assert.deepEqual(finished.steps[1]!.outputs, {
    summary: `fetched 2024-01-10 runs/${run.id}/download/raw.json`,
  });
});

test("outputs over the size bound fail the run with a diagnostic", async () => {
  const { configure, start, started, detail, platform } = setup();
  const workflowId = await configure(
    assetPrices([download(), { id: "big", type: "oversized" }]),
  );
  const run = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  await platform.idle();

  const failed = await detail(run.id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(
    failed.steps.map((step) => [step.id, step.status, step.attempts]),
    [
      ["download", "completed", 1],
      ["big", "failed", 1],
    ],
  );
  assert.match(
    failed.error ?? "",
    /^Step "big" failed: The outputs are \d+ bytes, over the 32768-byte limit/u,
  );
});

test("resolved inputs are validated against their contracts at execution", async () => {
  const { sqlite, configure, start, started, detail, platform, requests } =
    setup();
  const workflowId = await configure();
  // A saved step whose literal no longer satisfies its contract.
  sqlite
    .prepare(
      `UPDATE workflow_definitions SET steps_json = ? WHERE workflow_id = ?`,
    )
    .run(
      JSON.stringify([
        {
          ...download(),
          inputs: {
            ...download().inputs,
            throughDate: { value: "2024-13-45" },
          },
        },
      ]),
      workflowId,
    );

  const run = await started(start(workflowId));
  await platform.idle();
  const failed = await detail(run.id);
  assert.equal(failed.status, "failed");
  assert.match(
    failed.error ?? "",
    /Input "throughDate" does not satisfy contract "date"/u,
  );
  assert.equal(failed.steps[0]!.attempts, 1);
  assert.equal(requests.length, 0);
});

test("a launch whose response is lost is reconciled through the run's instance ID", async () => {
  const { configure, start, started, detail, platform, faults } = setup();
  const workflowId = await configure();

  faults.create = "lost";
  const run = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  faults.create = "none";
  assert.equal(run.status, "queued");
  await platform.idle();
  assert.equal((await detail(run.id)).status, "completed");
  assert.deepEqual([...platform.instances.keys()], [run.id]);
});

test("an unknown instance status never releases the claim", async () => {
  const { configure, start, started, detail, platform, faults } = setup();
  const workflowId = await configure();

  faults.create = "failed";
  faults.getUnavailable = true;
  const run = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  assert.equal(run.status, "queued");
  assert.equal(platform.instances.size, 0);

  // Still unknown: the claim holds and the new submission is skipped.
  const blocked = await started(start(workflowId));
  assert.equal(blocked.status, "skipped");
  assert.equal((await detail(run.id)).status, "queued");

  // Once the platform answers, reconciliation launches the claimed run
  // under its own ID, exactly once.
  faults.create = "none";
  faults.getUnavailable = false;
  const again = await started(start(workflowId));
  assert.equal(again.status, "skipped");
  await platform.idle();
  assert.equal((await detail(run.id)).status, "completed");
  assert.deepEqual([...platform.instances.keys()], [run.id]);
});

test("a run whose instance stopped without recording an outcome is failed by reconciliation", async () => {
  const { configure, start, started, detail, platform } = setup({
    platform: { autoStart: false },
  });
  const workflowId = await configure();
  const stuck = await started(start(workflowId));
  platform.instances.get(stuck.id)!.status = "errored";

  const next = await started(start(workflowId));
  assert.equal(next.status, "queued");
  const failed = await detail(stuck.id);
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.error,
    "The run's Workflow instance stopped (errored) without recording an outcome",
  );
});

test("active runs block deleting their configuration; allowed deletion keeps run history", async () => {
  const { api, json, configure, start, started, detail, artifact, platform } =
    setup({ platform: { autoStart: false } });
  const workflowId = await configure();
  const run = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );

  for (const path of [
    `/workflows/${workflowId}/assignments/asset/AAPL.US`,
    `/workflows/${workflowId}`,
    "/assets/AAPL.US",
  ]) {
    const blocked = await json<{ error: string }>(api(path, "DELETE"), 409);
    assert.match(
      blocked.error,
      new RegExp(`Run ${run.id} .* still active`, "u"),
    );
  }

  platform.start(run.id);
  await platform.idle();
  assert.equal((await api("/assets/AAPL.US", "DELETE")).status, 204);
  assert.equal((await api(`/workflows/${workflowId}`, "DELETE")).status, 204);

  const history = await detail(run.id);
  assert.equal(history.status, "completed");
  assert.equal(history.workflowName, "Daily asset prices");
  assert.deepEqual(history.subject, { kind: "asset", symbol: "AAPL.US" });
  assert.deepEqual(
    history.steps.map((step) => [step.id, step.type, step.status]),
    [["download", "download-prices", "completed"]],
  );
  assert.equal((await artifact(run.id)).entries.length, 7);
  const bySubject = await json<{ runs: WorkflowRunSummary[] }>(
    api("/runs?subjectKind=asset&subjectId=AAPL.US"),
  );
  assert.deepEqual(
    bySubject.runs.map((summary) => summary.id),
    [run.id],
  );
});

test("the app's pages read runs and their step outcomes", async () => {
  const { configure, start, started, platform, pages } = setup();
  const workflowId = await configure();
  const run = await started(
    start(workflowId, { processingDate: "2024-01-10" }),
  );
  await platform.idle();

  const listed = await pages.workflowRuns({ symbol: "aapl.us" });
  assert.deepEqual(
    listed.map((summary) => [summary.id, summary.status]),
    [[run.id, "completed"]],
  );
  assert.deepEqual(await pages.workflowRuns({ status: "failed" }), []);
  // An unknown status is ignored rather than rejected.
  assert.equal((await pages.workflowRuns({ status: "nope" })).length, 1);

  const detail = await pages.workflowRun(run.id);
  assert.deepEqual(
    detail.steps.map((step) => [step.id, step.status]),
    [["download", "completed"]],
  );
  assert.deepEqual(
    (await pages.workflow(workflowId)).runs.map((summary) => summary.id),
    [run.id],
  );
  assert.deepEqual(
    (await pages.asset("AAPL.US")).runs.map((summary) => summary.id),
    [run.id],
  );
  await assert.rejects(
    pages.workflowRun("not-a-run"),
    (error) => error instanceof PageDataError && error.status === 404,
  );
  await assert.rejects(
    pages.workflowRun(crypto.randomUUID()),
    (error) => error instanceof PageDataError && error.status === 404,
  );
});
