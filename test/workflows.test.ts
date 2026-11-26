import assert from "node:assert/strict";
import test from "node:test";

import { Layer, Schema } from "effect";

import { D1AssetsLive } from "$/assets/d1";
import type { Dependencies } from "$/dependencies";
import { pageData } from "$/pages";
import { D1PortfoliosLive } from "$/portfolios/d1";
import { createRoutes } from "$/routes";
import { D1DatasetPublicationStoreLive } from "$/datasets/d1";
import { memoryRunArtifacts } from "$/local/artifacts";
import { memoryDatasetObjectStore } from "$/local/published";
import { D1WorkflowsLive } from "$/workflows/d1";
import { D1WorkflowRunsLive } from "$/workflows/runs/d1";
import {
  builtInStepTypes,
  defineStepType,
  portfolioSubject,
  rawPricesEod,
  StepRegistryLayer,
  type StepType,
} from "$/workflows/registry";

import { makeTestDatabase } from "./support/d1";

const TOKEN = "management-token";

const PORTFOLIO = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

/** A test-only consumer of the download's raw output. */
const summarizeRaw = defineStepType({
  type: "summarize-raw",
  description: "Test step reading a raw download",
  scopes: ["asset"],
  params: Schema.Struct({}),
  inputs: { raw: { contract: rawPricesEod, description: "Raw prices" } },
  outputs: {},
});

/** A test-only portfolio step, so a valid portfolio specification exists. */
const notePortfolio = defineStepType({
  type: "note-portfolio",
  description: "Test step for portfolio workflows",
  scopes: ["portfolio"],
  params: Schema.Struct({}),
  inputs: {
    portfolio: { contract: portfolioSubject, description: "The portfolio" },
  },
  outputs: {},
});

const setup = (extraStepTypes: readonly StepType[] = []) => {
  const { sqlite, db } = makeTestDatabase();
  // Only the asset, portfolio and workflow factories are reached.
  const unused = () => Layer.empty;
  const dependencies = {
    statusFor: unused,
    registryFor: unused,
    scheduleFor: unused,
    calculationsFor: unused,
    engineFor: unused,
    assetsFor: () => D1AssetsLive(db),
    portfoliosFor: () => D1PortfoliosLive(db),
    workflowsFor: () =>
      Layer.merge(
        D1WorkflowsLive(db),
        StepRegistryLayer([...builtInStepTypes, ...extraStepTypes]),
      ),
    workflowRunsFor: () =>
      Layer.merge(D1WorkflowRunsLive(db), memoryRunArtifacts().layer),
    datasetsFor: () =>
      Layer.merge(
        D1DatasetPublicationStoreLive(db),
        memoryDatasetObjectStore().layer,
      ),
  } as unknown as Dependencies;
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
  const createAsset = (symbol: string) =>
    json(
      api("/assets", "POST", {
        symbol,
        provider: "eodhd",
        backfillStartDate: "2016-01-01",
      }),
      201,
    );
  const createWorkflow = (spec: unknown) =>
    json<{ id: string }>(api("/workflows", "POST", spec), 201);
  const count = (table: string) =>
    (
      sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;
  return {
    sqlite,
    api,
    json,
    createAsset,
    createWorkflow,
    count,
    pages: pageData({} as CloudflareBindings, dependencies),
  };
};

const download = {
  id: "download",
  type: "download-prices",
  params: { startDate: "2010-01-04" },
  inputs: {
    asset: { ref: "context.subject" },
    throughDate: { ref: "context.processingDate" },
  },
};

const assetPrices = {
  name: "Daily asset prices",
  scope: "asset",
  enabled: true,
  schedule: { hourUtc: 2 },
  steps: [download],
};

const portfolioNotes = {
  name: "Portfolio notes",
  scope: "portfolio",
  enabled: true,
  schedule: { hourUtc: 6 },
  steps: [
    {
      id: "note",
      type: "note-portfolio",
      inputs: { portfolio: { ref: "context.subject" } },
    },
  ],
};

test("workflow, assignment and catalog routes require the management token", async () => {
  const { api } = setup();
  const id = crypto.randomUUID();
  for (const [path, method] of [
    ["/workflows", "GET"],
    ["/workflows", "POST"],
    [`/workflows/${id}`, "GET"],
    [`/workflows/${id}`, "PUT"],
    [`/workflows/${id}`, "DELETE"],
    [`/workflows/${id}/assignments`, "GET"],
    [`/workflows/${id}/assignments`, "POST"],
    [`/workflows/${id}/assignments/asset/AAPL.US`, "PATCH"],
    [`/workflows/${id}/assignments/asset/AAPL.US`, "DELETE"],
    ["/step-types", "GET"],
    ["/assets", "GET"],
  ] as const) {
    assert.equal(
      (await api(path, method, undefined, "wrong")).status,
      401,
      `${method} ${path}`,
    );
  }
});

test("the step catalog exposes the registered step contracts", async () => {
  const { api, json } = setup();
  const catalog = await json<{
    stepTypes: Record<string, unknown>[];
    contracts: { id: string; schema: Record<string, unknown> }[];
    context: unknown[];
  }>(api("/step-types"));

  const downloadType = catalog.stepTypes.find(
    (stepType) => stepType.type === "download-prices",
  );
  assert.ok(downloadType);
  assert.deepEqual(downloadType.scopes, ["asset"]);
  assert.deepEqual(
    (downloadType.inputs as { name: string; contract: string }[]).map(
      ({ name, contract }) => ({ name, contract }),
    ),
    [
      { name: "asset", contract: "asset-subject" },
      { name: "throughDate", contract: "date" },
    ],
  );
  assert.deepEqual(
    (downloadType.outputs as { name: string; contract: string }[]).map(
      ({ name, contract }) => ({ name, contract }),
    ),
    [{ name: "raw", contract: "raw-prices-eod" }],
  );
  const params = downloadType.params as {
    type: string;
    properties: Record<string, unknown>;
  };
  assert.equal(params.type, "object");
  assert.deepEqual(Object.keys(params.properties), ["startDate"]);

  const ports = (type: string) => {
    const stepType = catalog.stepTypes.find((entry) => entry.type === type)!;
    const names = (list: unknown) =>
      (list as { name: string; contract: string }[]).map(
        ({ name, contract }) => `${name}:${contract}`,
      );
    return {
      inputs: names(stepType.inputs),
      outputs: names(stepType.outputs),
    };
  };
  assert.deepEqual(ports("normalize-prices"), {
    inputs: ["raw:raw-prices-eod"],
    outputs: ["prices:prices-eod"],
  });
  assert.deepEqual(ports("publish-dataset"), {
    inputs: ["data:prices-eod"],
    outputs: ["publication:dataset-publication"],
  });
  assert.deepEqual(ports("portfolio-holdings"), {
    inputs: ["portfolio:portfolio-subject", "processingDate:date"],
    outputs: ["holdingsDate:date", "holdings:holdings"],
  });
  assert.deepEqual(ports("wait-for-asset-publications"), {
    inputs: ["holdings:holdings", "processingDate:date"],
    outputs: ["publications:published-asset-prices"],
  });

  assert.deepEqual(
    catalog.contracts.map((contract) => contract.id),
    [
      "asset-subject",
      "dataset-publication",
      "date",
      "holdings",
      "portfolio-subject",
      "prices-eod",
      "published-asset-prices",
      "raw-prices-eod",
    ],
  );
  // Contracts generated from the Python service's Pydantic models keep
  // their constraints in the catalog.
  const pricesEod = catalog.contracts.find(
    (contract) => contract.id === "prices-eod",
  )!.schema as {
    $defs: Record<
      string,
      { properties: Record<string, Record<string, unknown>> }
    >;
  };
  const reference = pricesEod.$defs["PricesEodReference"]!.properties;
  assert.deepEqual(reference["format"]!["enum"], ["parquet"]);
  assert.match(String(reference["id"]!["pattern"]), /^\^runs/u);
  assert.deepEqual(catalog.context, [
    {
      field: "subject",
      description: "The asset or portfolio the run is for",
      contracts: { asset: "asset-subject", portfolio: "portfolio-subject" },
    },
    {
      field: "processingDate",
      description: "The date the run performs work for (UTC calendar date)",
      contracts: { asset: "date", portfolio: "date" },
    },
  ]);
});

test("a complete specification round-trips through POST, list, detail and PUT", async () => {
  const { api, json, createWorkflow } = setup();

  const created = await createWorkflow({
    ...assetPrices,
    name: "  Daily asset prices  ",
  });
  assert.deepEqual(
    { ...created, id: undefined, createdAt: undefined, updatedAt: undefined },
    {
      ...assetPrices,
      id: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    },
  );

  const list = await json<{ workflows: Record<string, unknown>[] }>(
    api("/workflows"),
  );
  assert.deepEqual(
    list.workflows.map(
      ({ id, name, scope, enabled, schedule, stepCount, assignmentCount }) => ({
        id,
        name,
        scope,
        enabled,
        schedule,
        stepCount,
        assignmentCount,
      }),
    ),
    [
      {
        id: created.id,
        name: "Daily asset prices",
        scope: "asset",
        enabled: true,
        schedule: { hourUtc: 2 },
        stepCount: 1,
        assignmentCount: 0,
      },
    ],
  );

  const replacement = {
    name: "Prices, paused",
    scope: "asset",
    enabled: false,
    schedule: { hourUtc: 23 },
    steps: [
      {
        id: "fetch",
        type: "download-prices",
        inputs: {
          asset: { ref: "context.subject" },
          throughDate: { value: "2026-10-30" },
        },
      },
    ],
  };
  const replaced = await json(
    api(`/workflows/${created.id}`, "PUT", replacement),
  );
  const detail = await json(api(`/workflows/${created.id}`));
  assert.deepEqual(detail, replaced);
  assert.deepEqual(
    { ...detail, id: undefined, createdAt: undefined, updatedAt: undefined },
    {
      ...replacement,
      // Omitted params are saved as an empty object.
      steps: [{ ...replacement.steps[0], params: {} }],
      id: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    },
  );

  assert.equal(
    (await api(`/workflows/${crypto.randomUUID()}`, "PUT", replacement)).status,
    404,
  );
  assert.equal((await api(`/workflows/${crypto.randomUUID()}`)).status, 404);
  assert.equal((await api("/workflows/not-a-uuid")).status, 400);
});

test("malformed specifications are rejected before registry validation", async () => {
  const { api } = setup();
  for (const spec of [
    { ...assetPrices, schedule: { hourUtc: 24 } },
    { ...assetPrices, schedule: { hourUtc: 1.5 } },
    { ...assetPrices, steps: [] },
    { ...assetPrices, scope: "fund" },
    { ...assetPrices, steps: [{ ...download, id: "has.dot" }] },
    {
      ...assetPrices,
      steps: [{ ...download, inputs: { asset: { value: 1, ref: "x" } } }],
    },
    { ...assetPrices, cron: "0 2 * * *" },
    { name: "No steps", scope: "asset", schedule: { hourUtc: 2 } },
  ]) {
    assert.equal(
      (await api("/workflows", "POST", spec)).status,
      400,
      JSON.stringify(spec),
    );
  }
});

/** Each invalid specification and the issues it must report, in order. */
const invalidCases: [string, unknown, { path: string[]; message: RegExp }[]][] =
  [
    [
      "duplicate step IDs",
      { ...assetPrices, steps: [download, download] },
      [
        {
          path: ["steps", "1", "id"],
          message: /Step ID "download" is already used by step 1/u,
        },
      ],
    ],
    [
      "unknown step type",
      { ...assetPrices, steps: [{ ...download, type: "teleport" }] },
      [
        {
          path: ["steps", "0", "type"],
          message: /Unknown step type "teleport"/u,
        },
      ],
    ],
    [
      "malformed parameters",
      {
        ...assetPrices,
        steps: [
          { ...download, params: { startDate: "2020-13-01", provider: "x" } },
        ],
      },
      [
        {
          path: ["steps", "0", "params", "provider"],
          message: /excess property/u,
        },
        { path: ["steps", "0", "params", "startDate"], message: /date/u },
      ],
    ],
    [
      "a step type outside the definition's scope",
      { ...assetPrices, scope: "portfolio" },
      [
        {
          path: ["steps", "0", "type"],
          message: /cannot be used in portfolio workflows/u,
        },
        {
          path: ["steps", "0", "inputs", "asset", "ref"],
          message:
            /expects contract "asset-subject" but "context.subject" provides "portfolio-subject"/u,
        },
      ],
    ],
    [
      "an incompatible input contract",
      {
        ...assetPrices,
        steps: [
          {
            ...download,
            inputs: {
              ...download.inputs,
              throughDate: { ref: "context.subject" },
            },
          },
        ],
      },
      [
        {
          path: ["steps", "0", "inputs", "throughDate", "ref"],
          message:
            /Input "throughDate" expects contract "date" but "context.subject" provides "asset-subject"/u,
        },
      ],
    ],
    [
      "a literal that does not satisfy the input contract",
      {
        ...assetPrices,
        steps: [
          {
            ...download,
            inputs: {
              ...download.inputs,
              asset: { value: { kind: "asset", symbol: "aapl" } },
            },
          },
        ],
      },
      [
        {
          path: ["steps", "0", "inputs", "asset", "value", "symbol"],
          message: /Literal for contract "asset-subject"/u,
        },
      ],
    ],
    [
      "missing and unknown inputs",
      {
        ...assetPrices,
        steps: [
          {
            ...download,
            inputs: { asset: { ref: "context.subject" }, until: { value: 1 } },
          },
        ],
      },
      [
        {
          path: ["steps", "0", "inputs", "until"],
          message: /has no input "until"/u,
        },
        {
          path: ["steps", "0", "inputs"],
          message: /Missing binding for input "throughDate"/u,
        },
      ],
    ],
    [
      "a reference to a missing step",
      {
        ...assetPrices,
        steps: [
          download,
          {
            ...download,
            id: "again",
            inputs: {
              ...download.inputs,
              throughDate: { ref: "steps.nowhere.outputs.raw" },
            },
          },
        ],
      },
      [
        {
          path: ["steps", "1", "inputs", "throughDate", "ref"],
          message: /refers to an unknown step "nowhere"/u,
        },
      ],
    ],
    [
      "a reference to the step's own output",
      {
        ...assetPrices,
        steps: [
          {
            ...download,
            inputs: {
              ...download.inputs,
              throughDate: { ref: "steps.download.outputs.raw" },
            },
          },
        ],
      },
      [
        {
          path: ["steps", "0", "inputs", "throughDate", "ref"],
          message: /refers to this step's own output/u,
        },
      ],
    ],
    [
      "a forward reference",
      {
        ...assetPrices,
        steps: [
          {
            ...download,
            id: "first",
            inputs: {
              ...download.inputs,
              throughDate: { ref: "steps.second.outputs.raw" },
            },
          },
          { ...download, id: "second" },
        ],
      },
      [
        {
          path: ["steps", "0", "inputs", "throughDate", "ref"],
          message: /refers to a later step/u,
        },
      ],
    ],
    [
      "an unknown or incompatible earlier output",
      {
        ...assetPrices,
        steps: [
          download,
          {
            ...download,
            id: "second",
            inputs: {
              asset: { ref: "steps.download.outputs.prices" },
              throughDate: { ref: "steps.download.outputs.raw" },
            },
          },
        ],
      },
      [
        {
          path: ["steps", "1", "inputs", "asset", "ref"],
          message:
            /Step "download" \(download-prices\) has no output "prices"/u,
        },
        {
          path: ["steps", "1", "inputs", "throughDate", "ref"],
          message: /expects contract "date" but .* provides "raw-prices-eod"/u,
        },
      ],
    ],
    [
      "unknown context fields and malformed references",
      {
        ...assetPrices,
        steps: [
          {
            ...download,
            inputs: {
              asset: { ref: "context.portfolio" },
              throughDate: { ref: "steps.download.outputs.raw.date" },
            },
          },
        ],
      },
      [
        {
          path: ["steps", "0", "inputs", "asset", "ref"],
          message: /Unknown run-context field "portfolio"/u,
        },
        {
          path: ["steps", "0", "inputs", "throughDate", "ref"],
          message: /Invalid reference/u,
        },
      ],
    ],
  ];

for (const [name, spec, expected] of invalidCases) {
  test(`saving rejects ${name}`, async () => {
    const { api, count } = setup();
    const response = await api("/workflows", "POST", spec);
    const body = (await response.json()) as {
      error: string;
      issues: { path: string[]; message: string }[];
    };
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(body.error, "The workflow specification is invalid");
    assert.equal(body.issues.length, expected.length, JSON.stringify(body));
    expected.forEach((issue, index) => {
      assert.deepEqual(body.issues[index]!.path, issue.path);
      assert.match(body.issues[index]!.message, issue.message);
    });
    assert.equal(count("workflow_definitions"), 0);
  });
}

test("an invalid replacement preserves the saved definition", async () => {
  const { api, json, createWorkflow } = setup();
  const created = await createWorkflow(assetPrices);
  const saved = await json(api(`/workflows/${created.id}`));

  const invalid = await api(`/workflows/${created.id}`, "PUT", {
    ...assetPrices,
    name: "Broken",
    steps: [download, download],
  });
  assert.equal(invalid.status, 422);
  assert.equal(
    (await api(`/workflows/${created.id}`, "PUT", { name: "Partial" })).status,
    400,
  );
  assert.deepEqual(await json(api(`/workflows/${created.id}`)), saved);
});

test("steps can bind any earlier step's named output", async () => {
  const { api, createWorkflow } = setup([summarizeRaw]);
  const created = await createWorkflow({
    ...assetPrices,
    steps: [
      download,
      {
        id: "summary",
        type: "summarize-raw",
        inputs: { raw: { ref: "steps.download.outputs.raw" } },
      },
      {
        id: "again",
        type: "summarize-raw",
        inputs: { raw: { ref: "steps.download.outputs.raw" } },
      },
    ],
  });
  assert.equal((await api(`/workflows/${created.id}`)).status, 200);
});

test("assignments are listed, added, disabled and removed, once per subject", async () => {
  const { api, json, createAsset, createWorkflow } = setup();
  await createAsset("AAPL.US");
  await createAsset("BRK-B.US");
  const { id } = await createWorkflow(assetPrices);
  const assignments = `/workflows/${id}/assignments`;

  const added = await json(
    api(assignments, "POST", { subject: { kind: "asset", symbol: "AAPL.US" } }),
    201,
  );
  assert.deepEqual(
    { ...added, createdAt: undefined, updatedAt: undefined },
    {
      workflowId: id,
      workflowName: "Daily asset prices",
      workflowEnabled: true,
      schedule: assetPrices.schedule,
      subject: { kind: "asset", symbol: "AAPL.US" },
      enabled: true,
      createdAt: undefined,
      updatedAt: undefined,
    },
  );
  await json(
    api(assignments, "POST", {
      subject: { kind: "asset", symbol: "BRK-B.US" },
      enabled: false,
    }),
    201,
  );

  // Unique per definition and subject.
  assert.equal(
    (
      await api(assignments, "POST", {
        subject: { kind: "asset", symbol: "AAPL.US" },
      })
    ).status,
    409,
  );
  // The subject must exist and match the definition's scope.
  assert.equal(
    (
      await api(assignments, "POST", {
        subject: { kind: "asset", symbol: "MSFT.US" },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await api(assignments, "POST", {
        subject: { kind: "portfolio", id: PORTFOLIO },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await api(`/workflows/${crypto.randomUUID()}/assignments`, "POST", {
        subject: { kind: "asset", symbol: "AAPL.US" },
      })
    ).status,
    404,
  );

  const disabled = await json(
    api(`${assignments}/asset/AAPL.US`, "PATCH", { enabled: false }),
  );
  assert.equal(disabled.enabled, false);

  const listed = await json<{
    assignments: { subject: unknown; enabled: boolean }[];
  }>(api(assignments));
  assert.deepEqual(
    listed.assignments.map(({ subject, enabled }) => ({ subject, enabled })),
    [
      { subject: { kind: "asset", symbol: "AAPL.US" }, enabled: false },
      { subject: { kind: "asset", symbol: "BRK-B.US" }, enabled: false },
    ],
  );
  const summary = await json<{ workflows: { assignmentCount: number }[] }>(
    api("/workflows"),
  );
  assert.equal(summary.workflows[0]!.assignmentCount, 2);

  assert.equal(
    (await api(`${assignments}/asset/AAPL.US`, "DELETE")).status,
    204,
  );
  assert.equal(
    (await api(`${assignments}/asset/AAPL.US`, "DELETE")).status,
    404,
  );
  assert.equal(
    (await api(`${assignments}/asset/AAPL.US`, "PATCH", { enabled: true }))
      .status,
    404,
  );
  assert.equal(
    (await api(`${assignments}/portfolio/not-a-uuid`, "DELETE")).status,
    400,
  );
  assert.equal(
    (await api(`/workflows/${crypto.randomUUID()}/assignments`)).status,
    404,
  );
});

test("the scope cannot change while the definition has assignments or is a default", async () => {
  const { api, json, createAsset, createWorkflow } = setup([notePortfolio]);
  await createAsset("AAPL.US");
  const { id } = await createWorkflow(assetPrices);
  await json(
    api(`/workflows/${id}/assignments`, "POST", {
      subject: { kind: "asset", symbol: "AAPL.US" },
    }),
    201,
  );

  const conflict = await api(`/workflows/${id}`, "PUT", portfolioNotes);
  assert.equal(conflict.status, 409);
  assert.equal((await json(api(`/workflows/${id}`))).scope, "asset");

  assert.equal(
    (await api(`/workflows/${id}/assignments/asset/AAPL.US`, "DELETE")).status,
    204,
  );
  await json(api(`/workflow-defaults/asset/${id}`, "PUT"));
  assert.equal(
    (await api(`/workflows/${id}`, "PUT", portfolioNotes)).status,
    409,
  );
  assert.equal(
    (await api(`/workflow-defaults/asset/${id}`, "DELETE")).status,
    204,
  );
  const changed = await json(api(`/workflows/${id}`, "PUT", portfolioNotes));
  assert.equal(changed.scope, "portfolio");
});

test("deleting an asset or a definition removes its assignments", async () => {
  const { api, json, createAsset, createWorkflow, count } = setup();
  await createAsset("AAPL.US");
  await createAsset("MSFT.US");
  const first = await createWorkflow(assetPrices);
  const second = await createWorkflow({ ...assetPrices, name: "Second" });
  for (const { id } of [first, second])
    for (const symbol of ["AAPL.US", "MSFT.US"])
      await json(
        api(`/workflows/${id}/assignments`, "POST", {
          subject: { kind: "asset", symbol },
        }),
        201,
      );
  assert.equal(count("workflow_assignments"), 4);

  assert.equal((await api("/assets/AAPL.US", "DELETE")).status, 204);
  assert.equal(count("workflow_assignments"), 2);

  assert.equal((await api(`/workflows/${first.id}`, "DELETE")).status, 204);
  assert.equal((await api(`/workflows/${first.id}`, "DELETE")).status, 404);
  assert.equal(count("workflow_assignments"), 1);
  assert.equal(count("workflow_definitions"), 1);
});

test("the app's pages read assets, definitions, assignments and step connections", async () => {
  const { api, json, createAsset, createWorkflow, pages } = setup([
    summarizeRaw,
  ]);
  await createAsset("AAPL.US");
  const { id } = await createWorkflow({
    ...assetPrices,
    steps: [
      download,
      {
        id: "summary",
        type: "summarize-raw",
        inputs: { raw: { ref: "steps.download.outputs.raw" } },
      },
    ],
  });
  await json(
    api(`/workflows/${id}/assignments`, "POST", {
      subject: { kind: "asset", symbol: "AAPL.US" },
    }),
    201,
  );

  assert.deepEqual(
    (await pages.assets()).map((asset) => asset.symbol),
    ["AAPL.US"],
  );
  const asset = await pages.asset("AAPL.US");
  assert.equal(asset.asset.symbol, "AAPL.US");
  assert.deepEqual(
    asset.assignments.map((a) => [a.workflowName, a.enabled]),
    [["Daily asset prices", true]],
  );
  await assert.rejects(pages.asset("MSFT.US"), { status: 404 });
  await assert.rejects(pages.asset("not a symbol"), { status: 404 });

  const workflows = await pages.workflows();
  assert.deepEqual(
    workflows.map((w) => [w.name, w.stepCount, w.assignmentCount]),
    [["Daily asset prices", 2, 1]],
  );

  const { inspection, assignments } = await pages.workflow(id);
  assert.equal(assignments.length, 1);
  assert.deepEqual(inspection.workflow, await json(api(`/workflows/${id}`)));
  assert.deepEqual(inspection.steps, [
    {
      position: 1,
      id: "download",
      type: "download-prices",
      description:
        "Download an asset's end-of-day prices from its provider through the throughDate, keeping the raw response as a run artifact",
      params: { startDate: "2010-01-04" },
      inputs: [
        {
          name: "asset",
          contract: "asset-subject",
          source: { kind: "context", ref: "context.subject", field: "subject" },
        },
        {
          name: "throughDate",
          contract: "date",
          source: {
            kind: "context",
            ref: "context.processingDate",
            field: "processingDate",
          },
        },
      ],
      outputs: [
        {
          name: "raw",
          contract: "raw-prices-eod",
          description: "The raw provider response, stored under the run",
          usedBy: [{ step: "summary", input: "raw" }],
        },
      ],
    },
    {
      position: 2,
      id: "summary",
      type: "summarize-raw",
      description: "Test step reading a raw download",
      params: {},
      inputs: [
        {
          name: "raw",
          contract: "raw-prices-eod",
          source: {
            kind: "output",
            ref: "steps.download.outputs.raw",
            step: "download",
            output: "raw",
          },
        },
      ],
      outputs: [],
    },
  ]);
  await assert.rejects(pages.workflow(crypto.randomUUID()), { status: 404 });
  await assert.rejects(pages.workflow("nope"), { status: 404 });
});
