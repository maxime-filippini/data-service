import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Result } from "effect";

import {
  HttpManagementApiLive,
  ManagementApi,
  type ManagementApiError,
} from "$/management-api/client";

const ORIGIN = "https://data-service.example.com";
const TOKEN = "management-token";

/** A client whose transport answers with `respond` and records each request. */
const client = (respond: (request: Request) => Promise<Response>) => {
  const requests: Request[] = [];
  const lines: string[] = [];
  const layer = HttpManagementApiLive({
    origin: ORIGIN,
    token: TOKEN,
    fetch: (request) => {
      requests.push(request);
      return respond(request);
    },
    onResponse: (line) => Effect.sync(() => void lines.push(line)),
  });
  const request = <T>(method: string, route: string, body?: unknown) =>
    ManagementApi.use((api) => api.request<T>(method, route, body)).pipe(
      Effect.provide(layer),
      Effect.result,
      Effect.runPromise,
    );
  return { request, requests, lines };
};

const failure = <T>(result: Result.Result<T, ManagementApiError>) => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

test("the client sends authenticated JSON to the instance's /api routes and decodes the reply", async () => {
  const { request, requests, lines } = client(async () =>
    Response.json({ id: "workflow-1" }, { status: 201 }),
  );

  const result = await request<{ id: string }>("POST", "/workflows", {
    name: "Daily prices",
  });

  assert.deepEqual(result, Result.succeed({ id: "workflow-1" }));
  const [sent] = requests;
  assert.equal(sent?.method, "POST");
  assert.equal(sent?.url, `${ORIGIN}/api/workflows`);
  assert.equal(sent?.headers.get("Authorization"), `Bearer ${TOKEN}`);
  assert.equal(sent?.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await sent?.json(), { name: "Daily prices" });
  assert.deepEqual(lines, ["POST /api/workflows -> 201"]);
});

test("a request without a body sends no content type, and an empty reply decodes to undefined", async () => {
  const { request, requests } = client(
    async () => new Response(null, { status: 204 }),
  );

  const result = await request("DELETE", "/assets/AAPL.US");

  assert.deepEqual(result, Result.succeed(undefined));
  assert.equal(requests[0]?.headers.get("Content-Type"), null);
});

test("a non-2xx reply fails with its status and body", async () => {
  const { request, lines } = client(async () =>
    Response.json(
      { error: "Asset AAPL.US appears in portfolio holdings" },
      {
        status: 409,
      },
    ),
  );

  const error = failure(await request("DELETE", "/assets/AAPL.US"));

  assert.equal(error.status, 409);
  assert.match(error.message, /^DELETE \/api\/assets\/AAPL\.US -> 409: /u);
  assert.match(error.message, /portfolio holdings/u);
  assert.deepEqual(lines, ["DELETE /api/assets/AAPL.US -> 409"]);
});

test("an unreachable instance fails without a status", async () => {
  const { request, lines } = client(async () => {
    throw new Error("connection refused");
  });

  const error = failure(await request("GET", "/runs"));

  assert.equal(error.status, null);
  assert.match(error.message, /GET \/api\/runs failed: .*connection refused/u);
  assert.deepEqual(lines, []);
});
