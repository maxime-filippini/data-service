import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { memoryRunArtifacts } from "$/local/artifacts";
import { fixtureSourceFor, loadEodhdFixtures } from "$/local/eodhd-fixtures";
import type { LocalPlatformOptions } from "$/local/platform";
import { localWorkflowService } from "$/local/runs";
import { pageData } from "$/pages";
import { createRoutes } from "$/routes";
import type { StepType } from "$/workflows/registry";
import type { RunPlatform } from "$/workflows/runs/contracts";

import { makeTestDatabase } from "./d1";

export const TOKEN = "management-token";

const fixtures = loadEodhdFixtures(
  fileURLToPath(new URL("../../fixtures/eodhd/", import.meta.url).href),
);

/** The download step of the standard asset prices workflow. */
export const downloadStep = (params: Record<string, unknown> = {}) => ({
  id: "download",
  type: "download-prices",
  params: { startDate: "2024-01-01", ...params },
  inputs: {
    asset: { ref: "context.subject" },
    throughDate: { ref: "context.processingDate" },
  },
});

/** A download-only asset workflow at the given daily UTC hour. */
export const assetPricesSpec = (hourUtc = 2, name = "Daily asset prices") => ({
  name,
  scope: "asset",
  enabled: true,
  schedule: { hourUtc },
  steps: [downloadStep()],
});

/**
 * The workflow service over real-migration SQLite, EODHD fixtures, memory
 * artifacts and the in-process Workflow binding, behind the real routes,
 * with faults injectable between the routes and the binding. `env` carries
 * the Worker vars tests set (such as `WORKFLOW_DISPATCH`).
 */
export const workflowService = (
  options: {
    readonly platform?: LocalPlatformOptions;
    readonly extraStepTypes?: readonly StepType[];
    /** Worker vars, such as `WORKFLOW_DISPATCH`. */
    readonly env?: Readonly<Record<string, string>>;
  } = {},
) => {
  const { sqlite, db } = makeTestDatabase();
  const artifacts = memoryRunArtifacts();
  const service = localWorkflowService({
    db,
    artifacts: artifacts.layer,
    sourceFor: fixtureSourceFor(fixtures),
    ...(options.extraStepTypes === undefined
      ? {}
      : { extraStepTypes: options.extraStepTypes }),
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
  const env = {
    MANAGEMENT_API_TOKEN: TOKEN,
    ...options.env,
  } as unknown as CloudflareBindings;
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

  const createAsset = (symbol: string, enabled = true) =>
    json(
      api("/assets", "POST", {
        symbol,
        provider: "eodhd",
        backfillStartDate: "2016-01-01",
        enabled,
      }),
      201,
    );
  const createWorkflow = async (spec: unknown = assetPricesSpec()) =>
    (await json<{ id: string }>(api("/workflows", "POST", spec), 201)).id;

  return {
    sqlite,
    env,
    api,
    json,
    createAsset,
    createWorkflow,
    platform,
    faults,
    dependencies,
    pages: pageData(env, dependencies),
  };
};
