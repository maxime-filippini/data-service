import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Effect, Result } from "effect";

import {
  HttpPythonOperationsLive,
  type OperationRequest,
  PythonOperations,
} from "$/operations/client";
import {
  type ExportedSchemas,
  GENERATED_PATH,
  generateOperationContracts,
  SCHEMAS_PATH,
} from "../scripts/operation-contracts";

const RUN_ID = "0b6c1f9e-5a2d-4c3b-9e8f-1a2b3c4d5e6f";

const request: OperationRequest<"normalize-prices-eod"> = {
  execution: { runId: RUN_ID, stepId: "normalize" },
  inputs: {
    raw: {
      id: `runs/${RUN_ID}/download/raw.json`,
      format: "json",
      schema: "raw-prices-eod/v1",
    },
  },
  params: {},
};

const prices = {
  id: `runs/${RUN_ID}/normalize/prices.parquet`,
  format: "parquet",
  schema: "prices-eod/v1",
};

test("the generated TypeScript contracts match the exported Pydantic schemas", async () => {
  // The Python suite checks schemas.json against the Pydantic models; this
  // checks the generated module against schemas.json.
  const exported = JSON.parse(
    readFileSync(SCHEMAS_PATH, "utf8"),
  ) as ExportedSchemas;
  assert.equal(
    await generateOperationContracts(exported),
    readFileSync(GENERATED_PATH, "utf8"),
    "Stale operation contracts: run `pnpm operations:generate`",
  );
});

test("a changed Pydantic schema changes the generated contracts", async () => {
  const exported = JSON.parse(
    readFileSync(SCHEMAS_PATH, "utf8"),
  ) as ExportedSchemas;
  const operation = exported.operations["normalize-prices-eod"]!;
  const changed = {
    ...exported,
    operations: {
      ...exported.operations,
      "normalize-prices-eod": {
        ...operation,
        response: {
          ...operation.response,
          properties: {
            ...(operation.response["properties"] as object),
            rowCount: { type: "integer" },
          },
          required: ["prices", "rowCount"],
        },
      },
    },
  };
  const generated = await generateOperationContracts(changed);
  assert.notEqual(generated, readFileSync(GENERATED_PATH, "utf8"));
  assert.match(generated, /readonly rowCount: number/u);
});

/** Call the client against a stand-in for the Python service's HTTP. */
const call = (
  respond: (url: string, init: RequestInit) => Promise<Response>,
  body: OperationRequest<"normalize-prices-eod"> = request,
) =>
  PythonOperations.use((python) =>
    python.invoke("normalize-prices-eod", body),
  ).pipe(
    Effect.provide(
      HttpPythonOperationsLive({ fetch: respond }, "http://python"),
    ),
    Effect.result,
    Effect.runPromise,
  );

const failure = async (
  respond: (url: string, init: RequestInit) => Promise<Response>,
  body?: OperationRequest<"normalize-prices-eod">,
) => {
  const result = await call(respond, body);
  assert.ok(Result.isFailure(result), "expected a failure");
  return { kind: result.failure.kind, message: result.failure.message };
};

test("a valid response is returned once it satisfies its contract", async () => {
  const sent: { url: string; body: unknown }[] = [];
  const result = await call(async (url, init) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ prices });
  });
  assert.ok(Result.isSuccess(result));
  assert.deepEqual(result.success, { prices });
  assert.deepEqual(sent, [
    { url: "http://python/operations/normalize-prices-eod", body: request },
  ]);
});

test("responses that break their contract are terminal failures", async () => {
  assert.deepEqual(
    await failure(async () =>
      Response.json({ prices: { ...prices, schema: "other" } }),
    ),
    {
      kind: "terminal",
      message:
        'The normalize-prices-eod response does not satisfy its contract: prices.schema: Expected "prices-eod/v1"',
    },
  );
  assert.equal(
    (await failure(async () => Response.json({ prices, extra: 1 }))).kind,
    "terminal",
  );
});

test("invalid requests are rejected before reaching Python", async () => {
  let called = false;
  const outcome = await failure(
    async () => {
      called = true;
      return Response.json({ prices });
    },
    {
      ...request,
      inputs: { raw: { ...request.inputs.raw, id: "../../etc/passwd" } },
    },
  );
  assert.equal(outcome.kind, "terminal");
  assert.match(outcome.message, /request does not satisfy its contract/u);
  assert.equal(called, false);
});

test("the error contract decides whether a failure is transient or terminal", async () => {
  assert.deepEqual(
    await failure(async () =>
      Response.json(
        {
          error: {
            kind: "terminal",
            message: "Invalid operation request",
            issues: [{ path: ["inputs", "raw"], message: "Field required" }],
          },
        },
        { status: 422 },
      ),
    ),
    {
      kind: "terminal",
      message: "Invalid operation request: inputs.raw: Field required",
    },
  );
  assert.deepEqual(
    await failure(async () =>
      Response.json(
        {
          error: {
            kind: "transient",
            message: "Could not read the run artifact",
          },
        },
        { status: 503 },
      ),
    ),
    { kind: "transient", message: "Could not read the run artifact" },
  );
});

test("failures outside the error contract are classified by status and transport", async () => {
  assert.equal(
    (await failure(async () => new Response("Bad gateway", { status: 502 })))
      .kind,
    "transient",
  );
  assert.equal(
    (await failure(async () => new Response("Nope", { status: 400 }))).kind,
    "terminal",
  );
  assert.deepEqual(
    await failure(async () => {
      throw new Error("connect ECONNREFUSED");
    }),
    {
      kind: "transient",
      message: "The Python service could not be reached: connect ECONNREFUSED",
    },
  );
  assert.equal(
    (await failure(async () => new Response("{trunc", { status: 200 }))).kind,
    "transient",
  );
});
