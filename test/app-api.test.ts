import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { DatasetPublicationStore, DatasetObjectStore } from "$/datasets/store";
import { memoryRunArtifacts } from "$/local/artifacts";
import { fixtureSourceFor } from "$/local/eodhd-fixtures";
import { memoryDatasetObjectStore } from "$/local/published";
import { localWorkflowService } from "$/local/runs";
import { createAppApiRoutes } from "$/routes/app-api";

import { makeTestDatabase } from "./support/d1";

const TEAM = "https://team.cloudflareaccess.com";

const AUD = "dashboard-aud";

const ME = "me@example.com";

const { publicKey, privateKey } = await generateKeyPair("RS256");

const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" }],
});

const baseEnv = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  DASHBOARD_ALLOWED_EMAILS: ` other@example.com, ${ME.toUpperCase()} `,
};

const signToken = (
  claims: { email?: string; aud?: string; iss?: string } = {},
  key = privateKey,
) =>
  new SignJWT(
    claims.email === undefined && "email" in claims
      ? {}
      : { email: claims.email ?? ME },
  )
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(claims.iss ?? TEAM)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);

const setup = (envOverrides: Record<string, unknown> = {}) => {
  const { sqlite, db } = makeTestDatabase();
  const published = memoryDatasetObjectStore();
  const local = localWorkflowService({
    db,
    artifacts: memoryRunArtifacts().layer,
    sourceFor: fixtureSourceFor(new Map()),
    published: published.layer,
    platform: { autoStart: false },
  });
  const api = createAppApiRoutes(local.dependencies, () => keys);
  // Mounted as in src/routes/index.ts.
  const app = new Hono().route("/app-api", api);
  const env = {
    ...baseEnv,
    ...envOverrides,
  } as unknown as CloudflareBindings;
  const request = async (
    path: string,
    token?: string,
    host = "https://data-service.example.workers.dev",
    headers: Record<string, string> = {},
  ) =>
    app.request(
      `${host}${path}`,
      {
        headers:
          token === undefined
            ? headers
            : { ...headers, "Cf-Access-Jwt-Assertion": token },
      },
      env,
    );
  /** A change sent from the app's own page. */
  const send = async (
    method: string,
    path: string,
    {
      body,
      token,
      headers = { Origin: "https://data-service.example.workers.dev" },
    }: {
      body?: unknown;
      token?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.request(
      `https://data-service.example.workers.dev${path}`,
      {
        method,
        headers: {
          ...headers,
          ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  return { sqlite, request, send, dependencies: local.dependencies, env };
};

test("an allowlisted Access user can use the API", async () => {
  const { request } = setup();
  const token = await signToken();

  const me = await request("/app-api/me", token);
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { email: ME });
  assert.equal(me.headers.get("Cache-Control"), "no-store");

  assert.equal((await request("/app-api/unknown", token)).status, 404);
});

test("requests without a valid Access token for an allowlisted email are refused", async () => {
  const { request } = setup();
  const { privateKey: otherKey } = await generateKeyPair("RS256");

  const cases: [string, string | undefined, number][] = [
    ["no token", undefined, 401],
    ["garbage", "not-a-jwt", 401],
    ["wrong signing key", await signToken({}, otherKey), 401],
    ["wrong audience", await signToken({ aud: "another-app" }), 401],
    [
      "wrong issuer",
      await signToken({ iss: "https://evil.cloudflareaccess.com" }),
      401,
    ],
    [
      "email not allowlisted",
      await signToken({ email: "stranger@example.com" }),
      403,
    ],
    ["service token (no email)", await signToken({ email: undefined }), 403],
  ];
  for (const [name, token, status] of cases) {
    for (const path of [
      "/app-api/me",
      "/app-api/assets",
      "/app-api/workflows",
    ]) {
      assert.equal(
        (await request(path, token)).status,
        status,
        `${name} ${path}`,
      );
    }
  }
});

test("missing Access settings close the API", async () => {
  const token = await signToken();
  for (const missing of [
    "ACCESS_TEAM_DOMAIN",
    "ACCESS_AUD",
    "DASHBOARD_ALLOWED_EMAILS",
  ]) {
    const { request } = setup({ [missing]: "" });
    assert.equal((await request("/app-api/me", token)).status, 503, missing);
  }
});

test("the team domain can be given without a scheme or with a trailing slash", async () => {
  const token = await signToken();
  for (const domain of ["team.cloudflareaccess.com", `${TEAM}/`]) {
    const { request } = setup({ ACCESS_TEAM_DOMAIN: domain });
    assert.equal((await request("/app-api/me", token)).status, 200, domain);
  }
});

test("the local bypass only works on localhost", async () => {
  const { request } = setup({
    DASHBOARD_LOCAL_BYPASS: "true",
    ACCESS_TEAM_DOMAIN: "",
  });
  const local = await request(
    "/app-api/me",
    undefined,
    "http://localhost:8787",
  );
  assert.equal(local.status, 200);
  assert.deepEqual(await local.json(), { email: "local@localhost" });
  assert.equal((await request("/app-api/me")).status, 503);
});

test("removed legacy app-api routes return 404", async () => {
  const { request, send } = setup();
  const token = await signToken();

  for (const path of [
    "/app-api/runs",
    "/app-api/symbols",
    "/app-api/options",
    "/app-api/registry",
    "/app-api/schedule",
    "/app-api/calculation-types",
    "/app-api/calculations",
    "/app-api/datasets/prices_eod/AAPL.US",
  ]) {
    assert.equal((await request(path, token)).status, 404, `GET ${path}`);
  }
  for (const path of [
    "/app-api/registry",
    "/app-api/ingestions",
    "/app-api/schedule/runs",
    "/app-api/calculate",
    "/app-api/calculations",
  ]) {
    assert.equal(
      (await send("POST", path, { token, body: {} })).status,
      404,
      `POST ${path}`,
    );
  }
});

test("changes need Access and must come from the app's own pages", async () => {
  const { send } = setup();
  const token = await signToken();
  const body = { name: "Core" };

  assert.equal(
    (await send("POST", "/app-api/portfolios", { body })).status,
    401,
  );
  const cases: [string, Record<string, string>, number][] = [
    ["no Origin", {}, 403],
    ["another site", { Origin: "https://evil.example" }, 403],
    ["another site, fetch metadata", { "Sec-Fetch-Site": "cross-site" }, 403],
    [
      "same origin, fetch metadata only",
      { "Sec-Fetch-Site": "same-origin" },
      201,
    ],
  ];
  for (const [name, headers, status] of cases) {
    assert.equal(
      (await send("POST", "/app-api/portfolios", { token, body, headers }))
        .status,
      status,
      name,
    );
  }
  assert.equal(
    (await send("GET", "/app-api/portfolios", { token, headers: {} })).status,
    200,
    "reads need no Origin",
  );
});

test("the app serves assets, workflow definitions and the step catalog behind Access", async () => {
  const { request, send } = setup();
  const token = await signToken();

  assert.equal((await request("/app-api/step-types")).status, 401);
  assert.equal(
    (await request("/app-api/workflows", await signToken({ email: "x@y.z" })))
      .status,
    403,
  );
  const catalog = await request("/app-api/step-types", token);
  assert.equal(catalog.status, 200);
  const { stepTypes } = (await catalog.json()) as {
    stepTypes: { type: string }[];
  };
  assert.deepEqual(
    stepTypes.map((stepType) => stepType.type),
    [
      "download-prices",
      "normalize-prices",
      "publish-dataset",
      "portfolio-holdings",
      "wait-for-asset-publications",
      "calculate-portfolio-volatility",
    ],
  );

  const asset = {
    symbol: "AAPL.US",
    provider: "eodhd",
    backfillStartDate: "2016-01-01",
  };
  assert.equal(
    (await send("POST", "/app-api/assets", { body: asset, token, headers: {} }))
      .status,
    403,
    "changes must come from the app's own pages",
  );
  assert.equal(
    (await send("POST", "/app-api/assets", { body: asset, token })).status,
    201,
  );
  const workflow = await send("POST", "/app-api/workflows", {
    token,
    body: {
      name: "Daily asset prices",
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
    },
  });
  assert.equal(workflow.status, 201);
  const { id } = (await workflow.json()) as { id: string };
  assert.equal(
    (
      await send("POST", `/app-api/workflows/${id}/assignments`, {
        token,
        body: { subject: { kind: "asset", symbol: "AAPL.US" } },
      })
    ).status,
    201,
  );
  const assets = (await (await request("/app-api/assets", token)).json()) as {
    assets: { symbol: string }[];
  };
  assert.deepEqual(
    assets.assets.map((a) => a.symbol),
    ["AAPL.US"],
  );
});

test("the app starts and lists workflow runs behind Access", async () => {
  const { request, send } = setup();
  const token = await signToken();
  assert.equal((await request("/app-api/workflow-runs")).status, 401);

  await send("POST", "/app-api/assets", {
    token,
    body: {
      symbol: "AAPL.US",
      provider: "eodhd",
      backfillStartDate: "2016-01-01",
    },
  });
  const created = await send("POST", "/app-api/workflows", {
    token,
    body: {
      name: "Daily asset prices",
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
    },
  });
  const { id } = (await created.json()) as { id: string };
  await send("POST", `/app-api/workflows/${id}/assignments`, {
    token,
    body: { subject: { kind: "asset", symbol: "AAPL.US" } },
  });

  const body = {
    workflowId: id,
    subject: { kind: "asset", symbol: "AAPL.US" },
  };
  assert.equal(
    (
      await send("POST", "/app-api/workflow-runs", {
        token,
        body,
        headers: {},
      })
    ).status,
    403,
    "starting a run must come from the app's own pages",
  );
  const started = await send("POST", "/app-api/workflow-runs", { token, body });
  assert.equal(started.status, 202);
  const run = (await started.json()) as { id: string; status: string };
  assert.equal(run.status, "queued");

  const list = (await (
    await request("/app-api/workflow-runs", token)
  ).json()) as { runs: { id: string }[] };
  assert.deepEqual(
    list.runs.map((r) => r.id),
    [run.id],
  );
  assert.equal(
    (await request(`/app-api/workflow-runs/${run.id}`, token)).status,
    200,
  );
});

test("the app reads published dataset metadata and streams Parquet with ETag revalidation", async () => {
  const { request, dependencies } = setup();
  const token = await signToken();
  assert.equal((await request("/app-api/publications")).status, 401);

  const bytes = new Uint8Array([0x50, 0x41, 0x52, 0x31]);
  const portfolioId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await Effect.gen(function* () {
    const store = yield* DatasetObjectStore;
    const metadata = yield* DatasetPublicationStore;
    const assetWritten = yield* store.put(
      "dataset=prices_eod/symbol=AAPL.US/data.parquet",
      bytes,
      "application/vnd.apache.parquet",
    );
    yield* metadata.record({
      dataset: "prices_eod",
      subject: { kind: "asset", symbol: "AAPL.US" },
      processingDate: "2026-10-18",
      workflowId,
      runId,
      stepId: "publish",
      sourceArtifact: `runs/${runId}/normalize/prices.parquet`,
      format: "parquet",
      schema: "prices-eod/v1",
      etag: assetWritten.etag,
      size: assetWritten.size,
      publishedAt: "2026-10-18T03:00:00.000Z",
    });
    const portfolioWritten = yield* store.put(
      `dataset=portfolio_volatility/portfolio=${portfolioId}/data.parquet`,
      bytes,
      "application/vnd.apache.parquet",
    );
    yield* metadata.record({
      dataset: "portfolio_volatility",
      subject: { kind: "portfolio", id: portfolioId },
      processingDate: "2026-10-18",
      workflowId,
      runId,
      stepId: "publish",
      sourceArtifact: `runs/${runId}/volatility/volatility.parquet`,
      format: "parquet",
      schema: "portfolio-volatility/v1",
      etag: portfolioWritten.etag,
      size: portfolioWritten.size,
      publishedAt: "2026-10-18T04:00:00.000Z",
    });
  }).pipe(Effect.provide(dependencies.datasetsFor()), Effect.runPromise);

  const listed = await request("/app-api/publications", token);
  assert.equal(listed.status, 200);
  const { publications } = (await listed.json()) as {
    publications: { dataset: string }[];
  };
  assert.deepEqual(publications.map((p) => p.dataset).sort(), [
    "portfolio_volatility",
    "prices_eod",
  ]);

  for (const path of [
    "/app-api/publications/prices_eod/asset/AAPL.US/data",
    `/app-api/publications/portfolio_volatility/portfolio/${portfolioId}/data`,
  ]) {
    const file = await request(path, token);
    assert.equal(file.status, 200, path);
    assert.equal(
      file.headers.get("Content-Type"),
      "application/vnd.apache.parquet",
    );
    assert.equal(file.headers.get("Cache-Control"), "private, no-cache");
    const etag = file.headers.get("ETag");
    assert.ok(etag);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);

    const cached = await request(path, token, undefined, {
      "If-None-Match": etag,
    });
    assert.equal(cached.status, 304, path);
  }

  assert.equal(
    (await request("/app-api/publications/prices_eod/asset/MSFT.US", token))
      .status,
    404,
  );
  assert.equal(
    (await request("/app-api/publications/nope/asset/AAPL.US", token)).status,
    400,
  );
});
