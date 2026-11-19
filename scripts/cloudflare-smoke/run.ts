import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { importJWK, SignJWT, type JWK } from "jose";

import type { PublicationView } from "$/datasets/contracts";
import type {
  WorkflowRunDetail,
  WorkflowRunStatus,
} from "$/workflows/runs/contracts";
import type { TickReport } from "$/workflows/runs/dispatch";

const processingDate = "2024-01-05";
const scheduledAt = `${processingDate}T05:00:00Z`;

interface InstanceView {
  readonly status: { status: string };
  readonly faults: readonly { point: string; detail: unknown }[];
}

interface PlatformLog {
  readonly status: string;
  readonly steps: readonly {
    name?: string;
    type: string;
    output?: string;
    attempts?: readonly { success: boolean; error?: { message: string } }[];
  }[];
}

const [directory, workerUrl] = process.argv.slice(2);
if (!directory || !workerUrl)
  throw new Error("Usage: run.ts <private-directory> <smoke-worker-url>");

const { resource, fixtureSymbolPrefix } = readJson<{
  resource: string;
  fixtureSymbolPrefix: string;
}>("resources.json");
const base = new URL(workerUrl);
assert.equal(base.protocol, "https:");
assert.ok(
  base.hostname.startsWith(`${resource}.`) &&
    base.hostname.endsWith(".workers.dev"),
);
const secrets = readJson<Record<string, string>>("secrets.json");
const accessKey = await importJWK(
  readJson<JWK>("access-private.jwk.json"),
  "RS256",
);
const accessToken = await new SignJWT({
  email: secrets.DASHBOARD_ALLOWED_EMAILS,
})
  .setProtectedHeader({ alg: "RS256" })
  .setIssuer(`https://${secrets.ACCESS_TEAM_DOMAIN}`)
  .setAudience(secrets.ACCESS_AUD!)
  .setExpirationTime("30m")
  .sign(accessKey);
const suffix = randomBytes(4).toString("hex").toUpperCase();
const fixtureSymbol = (role: string) =>
  `${fixtureSymbolPrefix}-${suffix}-${role}.US`;
const symbols = [fixtureSymbol("A"), fixtureSymbol("B")];
const evidenceDir = resolve(directory, `evidence-${suffix}`);
mkdirSync(evidenceDir, { mode: 0o700 });

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(directory!, file), "utf8")) as T;
}

function evidence(name: string, value: unknown) {
  writeFileSync(
    resolve(evidenceDir, `${name}.json`),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(name);
}

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      Authorization: `Bearer ${secrets.MANAGEMENT_API_TOKEN}`,
      "Cf-Access-Jwt-Assertion": accessToken,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(
    response.ok,
    `${method} ${path} returned ${response.status}: ${(response.ok ? "" : await response.text()).slice(0, 1500)}`,
  );
  return response;
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return (await request(method, `/api${path}`, body)).json() as Promise<T>;
}

async function poll<T>(
  name: string,
  get: () => Promise<T>,
  ready: (value: T) => boolean,
) {
  const expires = Date.now() + 6 * 60_000;
  let value = await get();
  while (!ready(value)) {
    if (Date.now() >= expires)
      throw new Error(
        `Timed out waiting for ${name}; last response: ${JSON.stringify(value)}`,
      );
    await setTimeout(1_500);
    value = await get();
  }
  return value;
}

function runAt(id: string, status: WorkflowRunStatus) {
  return poll(
    `run ${id} to be ${status}`,
    () => api<WorkflowRunDetail>("GET", `/runs/${id}`),
    (run) => {
      if (run.status === status) return true;
      if (["completed", "failed", "skipped"].includes(run.status))
        throw new Error(
          `Run ${id} ended ${run.status}, expected ${status}: ${run.error}`,
        );
      return false;
    },
  );
}

const publishedSteps = [
  {
    id: "download",
    type: "download-prices",
    inputs: {
      asset: { ref: "context.subject" },
      throughDate: { ref: "context.processingDate" },
    },
  },
  {
    id: "normalize",
    type: "normalize-prices",
    inputs: { raw: { ref: "steps.download.outputs.raw" } },
  },
  {
    id: "publish",
    type: "publish-dataset",
    params: { dataset: "prices_eod" },
    inputs: { data: { ref: "steps.normalize.outputs.prices" } },
  },
];

const portfolioSteps = (
  workflowId: string,
  timeoutSeconds: number,
  publishId: string,
) => [
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
    params: { workflowId, timeoutSeconds },
    inputs: {
      assets: { ref: "steps.holdings.outputs.assets" },
      processingDate: { ref: "context.processingDate" },
    },
  },
  {
    id: "volatility",
    type: "calculate-portfolio-volatility",
    params: { window: 3 },
    inputs: {
      holdings: { ref: "steps.holdings.outputs.holdings" },
      holdingsDate: { ref: "steps.holdings.outputs.holdingsDate" },
      publications: { ref: "steps.dependencies.outputs.publications" },
      processingDate: { ref: "context.processingDate" },
    },
  },
  {
    id: publishId,
    type: "publish-dataset",
    params: { dataset: "portfolio_volatility" },
    inputs: { data: { ref: "steps.volatility.outputs.data" } },
  },
];

async function tick(fault?: string) {
  const response = await request("POST", "/__smoke/tick", {
    at: scheduledAt,
    fault,
  });
  const result = (await response.json()) as TickReport;
  assert.equal(result.status, "dispatched");
  assert.deepEqual(result.failures, []);
  return result;
}

async function instance(id: string): Promise<InstanceView> {
  return (
    await request("GET", `/__smoke/instances/${id}`)
  ).json() as Promise<InstanceView>;
}

function platformCommand(action: "describe" | "pause" | "resume", id: string) {
  return execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "workflows",
      "instances",
      action,
      resource,
      id,
      ...(action === "describe" ? ["--json"] : []),
      "--config",
      resolve(directory!, "wrangler.smoke.json"),
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
}

function platformLogs(id: string): PlatformLog {
  return JSON.parse(platformCommand("describe", id)) as PlatformLog;
}

function platformStep(log: PlatformLog, name: string) {
  const found = log.steps.find((entry) => entry.name === `${name}-1`);
  assert.ok(found, `Cloudflare log has no step named ${name}`);
  return found;
}

function step(run: WorkflowRunDetail, id: string) {
  const outcome = run.steps.find((entry) => entry.id === id);
  assert.ok(outcome, `Run ${run.id} has no outcome for ${id}`);
  return outcome;
}

async function newAsset(symbol: string) {
  await api("POST", "/assets", {
    symbol,
    provider: "eodhd",
    backfillStartDate: "2024-01-01",
  });
  return { kind: "asset", symbol };
}

async function verifyParquet(path: string, name: string, expectedSize: number) {
  const response = await request("GET", path);
  const data = Buffer.from(await response.arrayBuffer());
  assert.equal(data.length, expectedSize);
  assert.equal(data.subarray(0, 4).toString(), "PAR1");
  assert.equal(data.subarray(-4).toString(), "PAR1");
  const target = resolve(evidenceDir, name);
  writeFileSync(target, data, { mode: 0o600 });
  return target;
}

const assetWorkflow = await api<{ id: string }>("POST", "/workflows", {
  name: `Smoke prices ${suffix}`,
  scope: "asset",
  enabled: true,
  schedule: { hourUtc: 2 },
  steps: publishedSteps,
});
const assets = await Promise.all(symbols.map(newAsset));
const portfolio = await api<{ id: string }>("POST", "/portfolios", {
  name: `Smoke portfolio ${suffix}`,
  snapshot: {
    holdingsDate: "2024-01-04",
    holdings: symbols.map((symbol, index) => ({
      symbol,
      weight: index === 0 ? 0.25 : 0.75,
    })),
  },
});
await api("POST", `/portfolios/${portfolio.id}/snapshots`, {
  holdingsDate: processingDate,
  holdings: symbols.map((symbol, index) => ({
    symbol,
    weight: index === 0 ? 0.25 : 1.25,
  })),
});
const spec = (timeout: number, publishId: string) => ({
  name: `Smoke portfolio volatility ${suffix}`,
  scope: "portfolio",
  enabled: true,
  schedule: { hourUtc: 4 },
  steps: portfolioSteps(assetWorkflow.id, timeout, publishId),
});
const portfolioWorkflow = await api<{ id: string }>(
  "POST",
  "/workflows",
  spec(300, "publish"),
);
const subject = { kind: "portfolio", id: portfolio.id };
await api("POST", `/workflows/${portfolioWorkflow.id}/assignments`, {
  subject,
});

const firstTick = await tick("lose-create-and-lookup");
assert.equal(firstTick.runs.length, 1);
const portfolioRun = firstTick.runs[0]!;
assert.equal(portfolioRun.workflowId, portfolioWorkflow.id);
assert.equal(portfolioRun.scheduledFor, `${processingDate}T04:00:00.000Z`);
const runId = portfolioRun.runId;
const waiting = await runAt(runId, "waiting");
const deadline = step(waiting, "dependencies").waiting?.deadline;
assert.ok(deadline);
assert.deepEqual(
  step(waiting, "dependencies").waiting?.missing.map(({ symbol }) => symbol),
  symbols,
);
const waitingPage = await (
  await request("GET", `/workflow-runs/${runId}`)
).text();
assert.match(waitingPage, /No successful run from the upstream workflow/u);
const secondTick = await tick("lose-lookup");
assert.deepEqual(secondTick.runs, []);
assert.ok(secondTick.reconciled.kept >= 1);
assert.equal(secondTick.reconciled.failed, 0);
const waitingRun = await api<WorkflowRunDetail>("GET", `/runs/${runId}`);
assert.equal(waitingRun.status, "waiting");
assert.equal(step(waitingRun, "dependencies").waiting?.deadline, deadline);
const waitingLog = platformLogs(runId);
assert.equal(
  platformStep(waitingLog, "start wait dependencies").output,
  deadline,
);
evidence("waiting", {
  firstTick,
  secondTick,
  run: waitingRun,
  instance: await instance(runId),
  platform: waitingLog,
});
platformCommand("pause", runId);
await poll(
  "paused Cloudflare instance",
  () => instance(runId),
  (entry) => entry.status.status === "paused",
);
assert.equal(
  step(await api<WorkflowRunDetail>("GET", `/runs/${runId}`), "dependencies")
    .waiting?.deadline,
  deadline,
);

await api(
  "PUT",
  `/workflows/${portfolioWorkflow.id}`,
  spec(5, "publish-updated"),
);
for (const asset of assets)
  await api("POST", `/workflows/${assetWorkflow.id}/assignments`, {
    subject: asset,
  });
const upstreamTick = await tick();
assert.equal(upstreamTick.runs.length, 2);
const upstream = await Promise.all(
  upstreamTick.runs.map(({ runId }) => runAt(runId, "completed")),
);
assert.ok(
  upstream.every(
    (run) =>
      run.trigger === "schedule" && run.processingDate === processingDate,
  ),
);
evidence("upstream", { tick: upstreamTick, runs: upstream });
assert.deepEqual((await tick()).runs, []);
platformCommand("resume", runId);

const finished = await runAt(runId, "completed");
assert.deepEqual(
  finished.steps.map(({ id }) => id),
  ["holdings", "dependencies", "volatility", "publish"],
);
assert.equal(step(finished, "holdings").attempts, 1);
assert.equal(
  step(finished, "holdings").startedAt,
  step(waiting, "holdings").startedAt,
);
assert.equal(step(finished, "volatility").attempts, 2);
assert.equal(step(finished, "publish").attempts, 2);
const completedLog = platformLogs(runId);
const completedInstance = await poll(
  "completed Cloudflare instance",
  () => instance(runId),
  (entry) => entry.status.status === "complete",
);
assert.equal(platformStep(completedLog, "wait dependencies 1").type, "sleep");
assert.deepEqual(
  platformStep(completedLog, "check dependencies 2").attempts?.map(
    ({ success }) => success,
  ),
  [true],
);
assert.deepEqual(
  platformStep(completedLog, "step holdings"),
  platformStep(waitingLog, "step holdings"),
);
assert.equal(
  platformStep(completedLog, "start wait dependencies").output,
  deadline,
);
for (const id of ["volatility", "publish"])
  assert.deepEqual(
    platformStep(completedLog, `step ${id}`).attempts?.map(
      ({ success }) => success,
    ),
    [false, true],
  );

const pythonFault = completedInstance.faults.find(
  ({ point }) => point === "python-response",
);
assert.deepEqual(pythonFault?.detail, step(finished, "volatility").outputs);
const calc = step(finished, "volatility").outputs?.summary as {
  volatility: number;
  observations: number;
};
assert.equal(calc.observations, 3);
assert.ok(Math.abs(calc.volatility - 0.16655193949753938) < 1e-12);

const dataset = `/datasets/portfolio_volatility/portfolio/${portfolio.id}`;
const publication = await api<PublicationView>("GET", dataset);
assert.equal(publication.producer.runId, runId);
const metadataFault = completedInstance.faults.find(
  ({ point }) => point === "publication-metadata",
);
assert.deepEqual(metadataFault?.detail, {
  etag: publication.etag,
  size: publication.size,
});
const parquet = await verifyParquet(
  `/api${dataset}/data`,
  "portfolio-volatility.parquet",
  publication.size,
);
execFileSync(
  "uv",
  [
    "run",
    "--directory",
    "containers/engine",
    "python",
    "-c",
    `
import datetime as dt
import math
import sys
import polars as pl

frame = pl.read_parquet(sys.argv[1])
assert frame.height == 1
row = frame.row(0, named=True)
assert row["portfolio_id"] == sys.argv[2]
assert row["as_of"] == dt.date.fromisoformat(sys.argv[3])
assert row["observations"] == 3
assert math.isclose(row["volatility"], 0.16655193949753938, abs_tol=1e-12)
`,
    parquet,
    portfolio.id,
    processingDate,
  ],
  { timeout: 60_000 },
);
const completedPage = await (
  await request("GET", `/workflow-runs/${runId}`)
).text();
assert.match(completedPage, /annualised volatility from 3 returns/u);
assert.match(completedPage, /portfolio_volatility/u);
evidence("completed", {
  run: finished,
  instance: completedInstance,
  platform: completedLog,
  publication,
});

const timeout = await api<{ id: string }>("POST", "/runs", {
  workflowId: portfolioWorkflow.id,
  subject,
  processingDate: "2024-01-06",
});
const timedOut = await runAt(timeout.id, "failed");
assert.match(timedOut.error ?? "", /Timed out waiting for asset publications/u);
assert.ok(symbols.every((symbol) => timedOut.error?.includes(symbol)));
const timeoutPage = await (
  await request("GET", `/workflow-runs/${timeout.id}`)
).text();
assert.match(timeoutPage, /Timed out waiting for asset publications/u);
const timeoutLog = platformLogs(timeout.id);
assert.equal(
  step(timedOut, "dependencies").waiting?.deadline,
  platformStep(timeoutLog, "start wait dependencies").output,
);
assert.deepEqual(
  platformStep(timeoutLog, "check dependencies 2").attempts?.map(
    ({ success }) => success,
  ),
  [false],
);
evidence("timed-out", { run: timedOut, platform: timeoutLog });

const rerun = await api<{ id: string }>("POST", `/runs/${runId}/rerun`);
assert.notEqual(rerun.id, runId);
const rerunDetails = await runAt(rerun.id, "completed");
assert.equal(rerunDetails.rerunOf, runId);
assert.equal(rerunDetails.trigger, "manual");
assert.equal(step(rerunDetails, "publish-updated").status, "completed");
evidence("rerun", rerunDetails);

const terminal = await api<{ id: string }>("POST", "/runs", {
  workflowId: assetWorkflow.id,
  subject: assets[0],
  processingDate: "2023-12-31",
});
const invalid = await runAt(terminal.id, "failed");
assert.match(invalid.error ?? "", /start date.*after the through date/u);
assert.equal(step(invalid, "download").attempts, 1);
const terminalLog = platformLogs(terminal.id);
assert.deepEqual(
  platformStep(terminalLog, "step download").attempts?.map(
    ({ success }) => success,
  ),
  [false],
);
evidence("terminal", { run: invalid, platform: terminalLog });

const unavailable = await newAsset(fixtureSymbol("RETRY"));
await api("POST", `/workflows/${assetWorkflow.id}/assignments`, {
  subject: unavailable,
});
const transient = await api<{ id: string }>("POST", "/runs", {
  workflowId: assetWorkflow.id,
  subject: unavailable,
  processingDate,
});
const exhausted = await runAt(transient.id, "failed");
assert.equal(step(exhausted, "download").attempts, 4);
assert.match(exhausted.error ?? "", /EODHD request failed/u);
const exhaustedLog = platformLogs(transient.id);
assert.deepEqual(
  platformStep(exhaustedLog, "step download").attempts?.map(
    ({ success }) => success,
  ),
  [false, false, false, false],
);
evidence("exhausted", { run: exhausted, platform: exhaustedLog });
console.log(`Evidence directory: ${evidenceDir}`);
