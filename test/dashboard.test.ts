import assert from "node:assert/strict";
import test from "node:test";

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { D1PipelineStatusLive } from "$/market-data/status/d1";
import type { RunPage, SymbolStatusView } from "$/market-data/status";
import { createDashboardRoutes } from "$/routes/dashboard";
import { makeTestDatabase } from "./support/d1";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "dashboard-aud";
const ME = "me@example.com";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" }] });

const signToken = (claims: { email?: string; aud?: string; iss?: string } = {}, key = privateKey) =>
  new SignJWT(claims.email === undefined && "email" in claims ? {} : { email: claims.email ?? ME })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(claims.iss ?? TEAM)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);

const baseEnv = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  DASHBOARD_ALLOWED_EMAILS: ` other@example.com, ${ME.toUpperCase()} `,
  ASSETS: { fetch: async (request: Request) => new Response(`asset ${new URL(request.url).pathname}`) },
};

const setup = (envOverrides: Record<string, unknown> = {}) => {
  const { sqlite, db } = makeTestDatabase();
  const app = createDashboardRoutes(() => D1PipelineStatusLive(db), () => keys);
  const env = { ...baseEnv, ...envOverrides } as unknown as CloudflareBindings;
  const request = async (path: string, token?: string, host = "https://data-service.example.workers.dev") =>
    app.request(
      `${host}${path}`,
      { headers: token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token } },
      env,
    );
  return { sqlite, request };
};

const insertRun = (
  sqlite: ReturnType<typeof makeTestDatabase>["sqlite"],
  run: { id: string; symbol?: string; status?: string; createdAt: string; error?: string },
) => {
  const status = run.status ?? "completed";
  const completed = status === "completed";
  sqlite
    .prepare(
      `INSERT INTO ingestion_runs (run_id, dataset, symbol, provider, requested_from, requested_to,
         status, created_at, completed_at, error, object_key, object_etag, row_count, observed_from, observed_to)
       VALUES (?, 'prices_eod', ?, 'eodhd', '2016-01-01', '2026-10-18', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.id,
      run.symbol ?? "AAPL.US",
      status,
      run.createdAt,
      status === "fetching" ? null : run.createdAt,
      run.error ?? null,
      completed ? `raw/${run.id}.json` : null,
      completed ? "etag" : null,
      completed ? 2700 : null,
      completed ? "2016-01-04" : null,
      completed ? "2026-10-17" : null,
    );
};

const insertJob = (
  sqlite: ReturnType<typeof makeTestDatabase>["sqlite"],
  job: { id: string; runId: string; symbol?: string; status: string; createdAt: string; error?: string },
) => {
  sqlite
    .prepare(
      `INSERT INTO processing_jobs (job_id, dataset, symbol, run_id, status, created_at, error)
       VALUES (?, 'prices_eod', ?, ?, ?, ?, ?)`,
    )
    .run(job.id, job.symbol ?? "AAPL.US", job.runId, job.status, job.createdAt, job.error ?? null);
};

const insertSymbol = (sqlite: ReturnType<typeof makeTestDatabase>["sqlite"], symbol: string, enabled = 1) => {
  sqlite
    .prepare(
      `INSERT INTO tracked_symbols VALUES ('prices_eod', ?, 'eodhd', ?, '2016-01-01',
         '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(symbol, enabled);
};

test("an allowlisted Access user can use the API and load the app", async () => {
  const { request } = setup();
  const token = await signToken();

  const me = await request("/api/me", token);
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { email: ME });
  assert.equal(me.headers.get("Cache-Control"), "no-store");

  const page = await request("/", token);
  assert.equal(await page.text(), "asset /");
  assert.match(page.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/u);

  assert.equal((await request("/api/unknown", token)).status, 404);
});

test("requests without a valid Access token for an allowlisted email are refused", async () => {
  const { request } = setup();
  const { privateKey: otherKey } = await generateKeyPair("RS256");

  const cases: [string, string | undefined, number][] = [
    ["no token", undefined, 401],
    ["garbage", "not-a-jwt", 401],
    ["wrong signing key", await signToken({}, otherKey), 401],
    ["wrong audience", await signToken({ aud: "another-app" }), 401],
    ["wrong issuer", await signToken({ iss: "https://evil.cloudflareaccess.com" }), 401],
    ["email not allowlisted", await signToken({ email: "stranger@example.com" }), 403],
    ["service token (no email)", await signToken({ email: undefined }), 403],
  ];
  for (const [name, token, status] of cases) {
    for (const path of ["/api/runs", "/"]) {
      assert.equal((await request(path, token)).status, status, `${name} ${path}`);
    }
  }
});

test("missing Access settings close the dashboard", async () => {
  const token = await signToken();
  for (const missing of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "DASHBOARD_ALLOWED_EMAILS"]) {
    const { request } = setup({ [missing]: "" });
    assert.equal((await request("/api/me", token)).status, 503, missing);
  }
});

test("the team domain can be given without a scheme or with a trailing slash", async () => {
  const token = await signToken();
  for (const domain of ["team.cloudflareaccess.com", `${TEAM}/`]) {
    const { request } = setup({ ACCESS_TEAM_DOMAIN: domain });
    assert.equal((await request("/api/me", token)).status, 200, domain);
  }
});

test("the local bypass only works on localhost", async () => {
  const { request } = setup({ DASHBOARD_LOCAL_BYPASS: "true", ACCESS_TEAM_DOMAIN: "" });
  const local = await request("/api/me", undefined, "http://localhost:8787");
  assert.equal(local.status, 200);
  assert.deepEqual(await local.json(), { email: "local@localhost" });
  assert.equal((await request("/api/me")).status, 503);
});

test("runs are listed newest first with their latest job, and page with a cursor", async () => {
  const { sqlite, request } = setup();
  const token = await signToken();
  insertRun(sqlite, { id: "r1", createdAt: "2026-10-01T02:00:00.000Z" });
  insertRun(sqlite, { id: "r2", createdAt: "2026-10-02T02:00:00.000Z", status: "failed", error: "Provider said no" });
  insertRun(sqlite, { id: "r3", createdAt: "2026-10-03T02:00:00.000Z", symbol: "MSFT.US" });
  insertRun(sqlite, { id: "r4", createdAt: "2026-10-03T02:00:00.000Z", status: "fetching" });
  insertJob(sqlite, { id: "j1", runId: "r1", status: "failed", createdAt: "2026-10-01T03:00:00.000Z" });
  insertJob(sqlite, { id: "j2", runId: "r1", status: "completed", createdAt: "2026-10-01T04:00:00.000Z" });

  const list = async (query: string) => {
    const response = await request(`/api/runs${query}`, token);
    assert.equal(response.status, 200, query);
    return (await response.json()) as RunPage;
  };

  const all = await list("");
  assert.deepEqual(all.runs.map((run) => run.runId), ["r4", "r3", "r2", "r1"]);
  assert.equal(all.nextCursor, null);
  assert.equal(all.runs[2]!.error, "Provider said no");
  assert.equal(all.runs[3]!.job?.jobId, "j2");
  assert.equal(all.runs[3]!.rowCount, 2700);
  assert.equal(all.runs[0]!.job, null);

  const first = await list("?limit=2");
  assert.deepEqual(first.runs.map((run) => run.runId), ["r4", "r3"]);
  assert.ok(first.nextCursor);
  const second = await list(`?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.deepEqual(second.runs.map((run) => run.runId), ["r2", "r1"]);
  assert.equal(second.nextCursor, null);

  assert.deepEqual((await list("?symbol=MSFT.US")).runs.map((run) => run.runId), ["r3"]);
  assert.deepEqual((await list("?status=failed")).runs.map((run) => run.runId), ["r2"]);
  assert.deepEqual((await list("?symbol=AAPL.US&status=completed")).runs.map((run) => run.runId), ["r1"]);

  for (const query of ["?limit=0", "?limit=201", "?status=queued", "?symbol=aapl", "?cursor=nope", "?extra=1"]) {
    assert.equal((await request(`/api/runs${query}`, token)).status, 400, query);
  }
});

test("symbols show their latest download, last success and latest rebuild", async () => {
  const { sqlite, request } = setup();
  const token = await signToken();
  insertSymbol(sqlite, "AAPL.US");
  insertSymbol(sqlite, "MSFT.US", 0);
  insertRun(sqlite, { id: "r1", createdAt: "2026-10-01T02:00:00.000Z" });
  insertRun(sqlite, { id: "r2", createdAt: "2026-10-02T02:00:00.000Z", status: "failed", error: "Timed out" });
  insertJob(sqlite, { id: "j1", runId: "r1", status: "failed", createdAt: "2026-10-01T03:00:00.000Z", error: "Bad" });

  const list = async (query = "") =>
    ((await (await request(`/api/symbols${query}`, token)).json()) as { symbols: SymbolStatusView[] }).symbols;

  const [aapl, msft] = await list();
  assert.equal(aapl!.symbol, "AAPL.US");
  assert.deepEqual(aapl!.latestRun, {
    runId: "r2",
    status: "failed",
    createdAt: "2026-10-02T02:00:00.000Z",
    completedAt: "2026-10-02T02:00:00.000Z",
    error: "Timed out",
  });
  assert.deepEqual(aapl!.lastCompletedRun, {
    runId: "r1",
    completedAt: "2026-10-01T02:00:00.000Z",
    rowCount: 2700,
    observedTo: "2026-10-17",
  });
  assert.equal(aapl!.latestJob?.status, "failed");
  assert.equal(aapl!.latestJob?.error, "Bad");

  assert.equal(msft!.enabled, false);
  assert.equal(msft!.latestRun, null);
  assert.equal(msft!.lastCompletedRun, null);
  assert.equal(msft!.latestJob, null);

  assert.deepEqual((await list("?enabled=true")).map((s) => s.symbol), ["AAPL.US"]);
  assert.equal((await request("/api/symbols?enabled=yes", token)).status, 400);
});
