/**
 * Run the asset download workflow locally against fixture data, through the
 * same API routes, executor and step implementations as the Worker:
 *
 *   pnpm workflow:fixture [--out DIR] [--symbol AAPL.US] [--date 2024-01-10]
 *
 * It creates an asset, a workflow definition and an assignment through the
 * management API, starts a manual run, waits for it, and leaves everything
 * to inspect in the output directory (default `.local/workflow-fixture`,
 * emptied first):
 *
 *   d1.sqlite                          the local D1 database (real migrations)
 *   r2/runs/<runId>/download/raw.json  the run's raw artifact
 *   run.json                           the run and its step outcomes (API view)
 *   api.log                            every API request and response status
 *
 * Provider responses come from `fixtures/eodhd/<SYMBOL>.json`, served to the
 * real EODHD adapter, so no credentials or network are needed. Retries
 * happen without waiting. The in-process Workflow binding is a stand-in: it
 * is not evidence of Cloudflare's durability.
 */

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { FileRunArtifactsLive } from "$/local/artifacts";
import { fixtureSourceFor, loadEodhdFixtures } from "$/local/eodhd-fixtures";
import { localWorkflowService } from "$/local/runs";
import { makeSqliteD1 } from "$/local/sqlite-d1";
import { createRoutes } from "$/routes";
import type { WorkflowRunDetail } from "$/workflows/runs/contracts";

const { values: options } = parseArgs({
  options: {
    out: { type: "string", default: ".local/workflow-fixture" },
    symbol: { type: "string", default: "AAPL.US" },
    date: { type: "string", default: "2024-01-10" },
    fixtures: { type: "string", default: "fixtures/eodhd" },
  },
});

const out = resolve(options.out);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const { db } = makeSqliteD1(join(out, "d1.sqlite"));
const service = localWorkflowService({
  db,
  artifacts: FileRunArtifactsLive(join(out, "r2")),
  sourceFor: fixtureSourceFor(loadEodhdFixtures(resolve(options.fixtures))),
  platform: { steps: { delayScale: 0 } },
});
const routes = createRoutes(service.dependencies, {
  fetch: () => new Response("No app locally", { status: 404 }),
});

// A local-only token: the management API's authentication stays in place.
const TOKEN = "local-fixture-token";
const env = { MANAGEMENT_API_TOKEN: TOKEN } as CloudflareBindings;

const api = async <T>(method: string, path: string, body?: unknown) => {
  const response = await routes.request(
    `http://localhost/api${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
  const text = await response.text();
  appendFileSync(
    join(out, "api.log"),
    `${method} /api${path} -> ${response.status}\n`,
  );
  if (!response.ok)
    throw new Error(`${method} /api${path} -> ${response.status}: ${text}`);
  return JSON.parse(text) as T;
};

const symbol = options.symbol;
await api("POST", "/assets", {
  symbol,
  provider: "eodhd",
  backfillStartDate: "2024-01-01",
});
const workflow = await api<{ id: string }>("POST", "/workflows", {
  name: "Daily asset prices (fixture)",
  scope: "asset",
  enabled: true,
  schedule: { hourUtc: 2 },
  steps: [
    {
      id: "download",
      type: "download-prices",
      inputs: {
        asset: { ref: "context.subject" },
        throughDate: { ref: "context.processingDate" },
      },
    },
  ],
});
await api("POST", `/workflows/${workflow.id}/assignments`, {
  subject: { kind: "asset", symbol },
});
const started = await api<{ id: string }>("POST", "/runs", {
  workflowId: workflow.id,
  subject: { kind: "asset", symbol },
  processingDate: options.date,
});

await service.platform.idle();
const run = await api<WorkflowRunDetail>("GET", `/runs/${started.id}`);
writeFileSync(join(out, "run.json"), `${JSON.stringify(run, null, 2)}\n`);

const show = (path: string) => relative(process.cwd(), path) || ".";
console.log(`Run ${run.id}: ${run.status}`);
for (const step of run.steps)
  console.log(
    `  ${step.position}. ${step.id} (${step.type}): ${step.status}` +
      (step.error === null ? "" : ` - ${step.error}`),
  );
for (const step of run.steps)
  for (const value of Object.values(step.outputs ?? {}))
    if (typeof value === "object" && value !== null && "id" in value)
      console.log(`  artifact: ${show(join(out, "r2", String(value.id)))}`);
console.log(`Run record: ${show(join(out, "run.json"))}`);
console.log(`Database:   ${show(join(out, "d1.sqlite"))}`);
if (run.status !== "completed") process.exitCode = 1;
