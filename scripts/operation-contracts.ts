/**
 * Generate the Worker's TypeScript operation contracts from the JSON Schemas
 * the Python service exports (`src/operations/schemas.json`, written by
 * `uv run engine export-schemas`). The output is Effect Schema code, so the
 * same generated definitions give compile-time types and runtime validation.
 *
 * Effect's own JSON Schema importer and code generator do the translation;
 * this module only merges the Pydantic documents' `$defs` into one shared
 * pool, names the roots and formats the file.
 */

import { JsonSchema, SchemaRepresentation } from "effect";
import * as prettier from "prettier";

/** Where the exported schemas and the generated module live. */
export const SCHEMAS_PATH = "src/operations/schemas.json";
export const GENERATED_PATH = "src/operations/contracts.generated.ts";

type Json = Record<string, unknown>;

interface ExportedOperation {
  readonly description: string;
  readonly request: Json;
  readonly response: Json;
}

/** The shape `export_schemas()` writes. */
export interface ExportedSchemas {
  readonly operations: Readonly<Record<string, ExportedOperation>>;
  readonly error: Json;
}

/** `normalize-prices-eod` → `NormalizePricesEod`. */
const pascal = (name: string) =>
  name
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

/**
 * Patterns for the string formats Pydantic emits for `date` and `datetime`
 * fields. Effect only records `format` as an annotation, so without these the
 * generated schemas would accept any string. Pydantic still parses the value.
 */
const FORMAT_PATTERNS: Readonly<Record<string, string>> = {
  date: "^\\d{4}-\\d{2}-\\d{2}$",
  "date-time":
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})?$",
};

/**
 * Pydantic's titles repeat the field or class name ("Runid"), so they are
 * dropped. `date` and `date-time` formats become patterns; any other format
 * is refused rather than silently left unchecked. RegExp sources are
 * normalized as JavaScript prints them (`/` escaped), which Effect's pattern
 * reviver requires.
 */
const clean = (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  const { title: _title, ...rest } = schema as Json;
  const format = rest["format"];
  if (typeof format === "string") {
    const pattern = FORMAT_PATTERNS[format];
    if (pattern === undefined)
      throw new Error(
        `The "${format}" string format is not supported by the operation contract generator; add a pattern for it in scripts/operation-contracts.ts`,
      );
    if (rest["pattern"] === undefined) rest["pattern"] = pattern;
  }
  return typeof rest["pattern"] === "string"
    ? { ...rest, pattern: new RegExp(rest["pattern"], "u").source }
    : rest;
};

/** Split each root's `$defs` into one shared pool; a name must mean one thing. */
const pool = (roots: readonly Json[]) => {
  const definitions: Record<string, JsonSchema.JsonSchema> = {};
  const schemas = roots.map((root) => {
    const { $defs, ...schema } = root as Json & {
      $defs?: Record<string, JsonSchema.JsonSchema>;
    };
    for (const [name, definition] of Object.entries($defs ?? {})) {
      const known = definitions[name];
      if (
        known !== undefined &&
        JSON.stringify(known) !== JSON.stringify(definition)
      )
        throw new Error(
          `Two operation contracts define "${name}" differently; rename one of the Pydantic models`,
        );
      definitions[name] = definition;
    }
    return schema as JsonSchema.JsonSchema;
  });
  return { schemas, definitions };
};

/** The generated module's source for the exported schemas. */
export const generateOperationContracts = async (
  exported: ExportedSchemas,
): Promise<string> => {
  const operations = Object.entries(exported.operations).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const roots = [
    { name: "OperationErrorResponse", schema: exported.error },
    ...operations.flatMap(([name, operation]) => [
      { name: `${pascal(name)}Request`, schema: operation.request },
      { name: `${pascal(name)}Response`, schema: operation.response },
    ]),
  ];
  const { schemas, definitions } = pool(roots.map((root) => root.schema));
  const imported = SchemaRepresentation.fromJsonSchemaMultiDocument(
    {
      dialect: "draft-2020-12",
      schemas: schemas as [JsonSchema.JsonSchema, ...JsonSchema.JsonSchema[]],
      definitions,
    },
    { patterns: "apply", onEnter: clean },
  );
  const code = SchemaRepresentation.toCodeDocument(
    SchemaRepresentation.toRepresentations(
      imported.map((schema) => schema.ast) as [
        (typeof imported)[0]["ast"],
        ...(typeof imported)[0]["ast"][],
      ],
    ),
  );
  if (
    Object.keys(code.references.recursives).length > 0 ||
    code.artifacts.length > 0
  )
    throw new Error(
      "Recursive or non-JSON operation contracts are not supported by the generator",
    );

  const declare = (name: string, generated: SchemaRepresentation.Code) =>
    `export type ${name} = ${generated.Type};\nexport const ${name} = ${generated.runtime};`;

  const source = [
    "// Generated by scripts/generate-operation-contracts.ts from",
    "// src/operations/schemas.json (the Python service's Pydantic contracts).",
    "// Do not edit: run `pnpm operations:generate`.",
    "",
    'import { Schema } from "effect";',
    "",
    ...code.references.nonRecursives.map(({ $ref, code: generated }) =>
      declare($ref, generated),
    ),
    ...roots.map(({ name }, index) => declare(name, code.codes[index]!)),
    "",
    "/** Every operation the Python service exposes, by name. */",
    "export const operations = {",
    ...operations.map(
      ([name, operation]) =>
        `  ${JSON.stringify(name)}: { name: ${JSON.stringify(name)}, description: ${JSON.stringify(operation.description)}, request: ${pascal(name)}Request, response: ${pascal(name)}Response },`,
    ),
    "} as const;",
    "",
    "export type OperationName = keyof typeof operations;",
    "",
  ].join("\n");
  return prettier.format(source, { parser: "typescript" });
};
