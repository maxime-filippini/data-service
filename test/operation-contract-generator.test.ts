/**
 * The contract generator against real Pydantic output: the fixture is the
 * JSON Schema export of `containers/engine/tests/contract_shapes.py`, which
 * covers the field shapes operation contracts may use. Each generated schema
 * is imported and run on valid and invalid values; when uv is available the
 * same values go through the Pydantic models, so the generated schemas are
 * never more lenient than Python.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { Result, Schema } from "effect";

import { uvAvailable } from "$/local/python";

import {
  type ExportedSchemas,
  generateOperationContracts,
} from "../scripts/operation-contracts";

const SHAPES_PATH = "fixtures/operation-contracts/shapes.json";
const shapes = () =>
  JSON.parse(readFileSync(SHAPES_PATH, "utf8")) as ExportedSchemas;

/**
 * Generate a module and import it. It lives under node_modules so `effect`
 * resolves, as `.mts` so it loads as ESM: a `.ts` file there loads as CommonJS
 * with a second copy of effect whose schemas this module cannot decode.
 */
let generatedModules = 0;
const importGenerated = async (exported: ExportedSchemas) => {
  const directory = join("node_modules", ".cache", "operation-contract-tests");
  mkdirSync(directory, { recursive: true });
  const file = join(
    directory,
    `contracts-${process.pid}-${generatedModules++}.mts`,
  );
  writeFileSync(file, await generateOperationContracts(exported));
  return (await import(join(process.cwd(), file))) as Record<
    string,
    Schema.Codec<unknown, unknown>
  > & {
    operations: Record<
      string,
      { name: string; description: string; request: unknown; response: unknown }
    >;
  };
};

/** Decode as the operation client does: every issue, unknown keys rejected. */
const accepts = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
  Result.isSuccess(
    Schema.decodeUnknownResult(schema, {
      errors: "all",
      onExcessProperty: "error",
    })(value),
  );

const validRequest = {
  requiredText: "abc",
  nullableCount: null,
  count: 3,
  ratio: 0.5,
  frequency: "daily",
  mode: "fast",
  version: "v1",
  day: "2024-01-05",
  at: "2024-01-05T03:00:00Z",
  path: "runs/abc/raw.json",
  tags: ["a", "b"],
  windows: [{ start: "2024-01-01", end: "2024-01-05" }],
  weights: { "AAPL.US": 0.5 },
  pair: ["x", 1],
  scheme: { kind: "fixed", weight: 0.5 },
};

interface Case {
  readonly name: string;
  readonly model: string;
  readonly value: unknown;
  readonly valid: boolean;
  /** Pydantic's lax JSON mode accepts what the generated schema rejects. */
  readonly stricterThanPydantic?: true;
}

const request = (
  name: string,
  changes: Record<string, unknown>,
  valid: boolean,
): Case => ({
  name,
  model: "ShapesRequest",
  value: { ...validRequest, ...changes },
  valid,
});
const without = (key: keyof typeof validRequest) => {
  const { [key]: _omitted, ...rest } = validRequest;
  return rest;
};

const cases: readonly Case[] = [
  {
    name: "a complete request",
    model: "ShapesRequest",
    value: validRequest,
    valid: true,
  },
  request("optional fields given", { optionalText: "x", enabled: false }, true),
  request("an optional field set to null", { optionalText: null }, true),
  request("a nullable field with a value", { nullableCount: 4 }, true),
  request("the other enum member", { frequency: "weekly" }, true),
  request("the other literal", { mode: "slow" }, true),
  request("the other union member", { scheme: { kind: "equal" } }, true),
  request(
    "a timestamp with an offset",
    { at: "2024-01-05T03:00:00.250+01:00" },
    true,
  ),
  request("empty containers", { tags: [], windows: [], weights: {} }, true),
  {
    name: "a missing nullable field",
    model: "ShapesRequest",
    value: without("nullableCount"),
    valid: false,
  },
  {
    name: "a missing required field",
    model: "ShapesRequest",
    value: without("scheme"),
    valid: false,
  },
  request("an unknown field", { extra: 1 }, false),
  request("an empty string under min_length", { requiredText: "" }, false),
  request("a string over max_length", { requiredText: "123456789" }, false),
  request("an integer over le", { count: 11 }, false),
  request("an integer under ge", { count: -1 }, false),
  request("a fractional integer", { count: 1.5 }, false),
  request("a string for a number", { ratio: "x" }, false),
  request("an unknown enum member", { frequency: "monthly" }, false),
  request("an unknown literal", { mode: "medium" }, false),
  request("the wrong constant", { version: "v2" }, false),
  request("a date without padding", { day: "2024-1-5" }, false),
  request("a word for a date", { day: "yesterday" }, false),
  {
    ...request("a date for a timestamp", { at: "2024-01-05" }, false),
    stricterThanPydantic: true,
  },
  request("a path breaking its pattern", { path: "runs/ABC/raw.json" }, false),
  request("a number in a string list", { tags: [1] }, false),
  request(
    "a nested model missing a field",
    { windows: [{ start: "2024-01-01" }] },
    false,
  ),
  request(
    "a nested model with an unknown field",
    { windows: [{ start: "2024-01-01", end: "2024-01-05", extra: 1 }] },
    false,
  ),
  request("a string in a number record", { weights: { a: "x" } }, false),
  request("a short tuple", { pair: ["x"] }, false),
  request("a tuple item of the wrong type", { pair: ["x", "y"] }, false),
  request(
    "a union member missing a field",
    { scheme: { kind: "fixed" } },
    false,
  ),
  request("an unknown discriminator", { scheme: { kind: "other" } }, false),
  request(
    "a value at gt's bound",
    { scheme: { kind: "fixed", weight: 0 } },
    false,
  ),
  request("a value over le", { scheme: { kind: "fixed", weight: 1.5 } }, false),
  {
    name: "a response without its optional field",
    model: "ShapesResponse",
    value: { window: { start: "2024-01-01", end: "2024-01-05" } },
    valid: true,
  },
  {
    name: "an optional nested model set to null",
    model: "ShapesResponse",
    value: {
      window: { start: "2024-01-01", end: "2024-01-05" },
      maybeWindow: null,
    },
    valid: true,
  },
  {
    name: "a model with no fields",
    model: "OtherRequest",
    value: { window: { start: "2024-01-01", end: "2024-01-05" }, params: {} },
    valid: true,
  },
  {
    name: "a field on a model with no fields",
    model: "OtherRequest",
    value: {
      window: { start: "2024-01-01", end: "2024-01-05" },
      params: { extra: 1 },
    },
    valid: false,
  },
];

/** The generated export each Pydantic model in the cases maps to. */
const exportFor: Record<string, string> = {
  ShapesRequest: "CheckShapesRequest",
  ShapesResponse: "CheckShapesResponse",
  OtherRequest: "OtherOperationRequest",
  OtherResponse: "OtherOperationResponse",
};

test("generated schemas accept and reject each field shape as the Pydantic models do", async () => {
  const generated = await importGenerated(shapes());
  for (const { name, model, value, valid } of cases)
    assert.equal(
      accepts(generated[exportFor[model]!]!, value),
      valid,
      `${valid ? "should accept" : "should reject"} ${name}`,
    );
});

test(
  "Pydantic agrees with every case, so the generated schemas are never more lenient",
  {
    skip: uvAvailable()
      ? false
      : "uv is not installed, so the Pydantic models cannot run",
  },
  () => {
    const verdicts = JSON.parse(
      execFileSync(
        "uv",
        [
          "run",
          "--directory",
          "containers/engine",
          "python",
          "-m",
          "tests.contract_shapes",
          "--validate",
        ],
        {
          encoding: "utf8",
          input: JSON.stringify(
            cases.map(({ model, value }) => ({ model, value })),
          ),
        },
      ),
    ) as boolean[];
    cases.forEach(({ name, valid, stricterThanPydantic }, index) =>
      assert.equal(
        verdicts[index],
        valid || stricterThanPydantic === true,
        `Pydantic disagrees on ${name}`,
      ),
    );
  },
);

test("operations are exported by name, sorted, with their descriptions", async () => {
  const exported = shapes();
  const reversed = {
    ...exported,
    operations: Object.fromEntries(
      Object.entries(exported.operations).reverse(),
    ),
  };
  const generated = await importGenerated(reversed);
  assert.deepEqual(Object.keys(generated.operations), [
    "check-shapes",
    "other-operation",
  ]);
  const operation = generated.operations["other-operation"]!;
  assert.equal(operation.name, "other-operation");
  assert.equal(operation.description, "Shares a model with check-shapes");
  assert.equal(operation.request, generated["OtherOperationRequest"]);
  assert.equal(operation.response, generated["OtherOperationResponse"]);
  assert.ok(generated["OperationErrorResponse"]);
});

test("the output is stable, shares definitions once and drops Pydantic's titles", async () => {
  const exported = shapes();
  const source = await generateOperationContracts(exported);
  const reversed = await generateOperationContracts({
    ...exported,
    operations: Object.fromEntries(
      Object.entries(exported.operations).reverse(),
    ),
  });
  assert.equal(reversed, source);
  assert.equal(source.match(/^export const Window = /gmu)?.length, 1);
  assert.doesNotMatch(source, /Requiredtext|Nullablecount/u);
  assert.match(source, /^\/\/ Do not edit: run `pnpm operations:generate`\./mu);
});

/** The fixture with one operation's request schema replaced. */
const withRequest = (request: Record<string, unknown>): ExportedSchemas => {
  const exported = shapes();
  return {
    ...exported,
    operations: {
      ...exported.operations,
      "other-operation": {
        ...exported.operations["other-operation"]!,
        request,
      },
    },
  };
};

test("two operations defining a shared model differently are refused", async () => {
  const exported = shapes();
  const request = structuredClone(
    exported.operations["other-operation"]!.request,
  ) as { $defs: Record<string, { properties: Record<string, unknown> }> };
  request.$defs["Window"]!.properties["label"] = { type: "string" };
  await assert.rejects(
    generateOperationContracts(withRequest(request)),
    /Two operation contracts define "Window" differently/u,
  );
});

test("recursive models are refused", async () => {
  await assert.rejects(
    generateOperationContracts(
      withRequest({
        $defs: {
          Node: {
            type: "object",
            properties: {
              children: { type: "array", items: { $ref: "#/$defs/Node" } },
            },
            required: ["children"],
            additionalProperties: false,
          },
        },
        $ref: "#/$defs/Node",
      }),
    ),
    /Recursive operation contracts are not supported/u,
  );
});

test("string formats without a pattern are refused instead of left unchecked", async () => {
  await assert.rejects(
    generateOperationContracts(
      withRequest({
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
        required: ["id"],
        additionalProperties: false,
      }),
    ),
    /The "uuid" string format is not supported/u,
  );
});
