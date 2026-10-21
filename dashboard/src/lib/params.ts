// Reading a calculation type's params JSON Schema (as Pydantic writes it) for
// the help shown next to the params editor. The dashboard doesn't build a form
// from it; the engine checks the params.

type JsonSchema = {
  type?: string | string[];
  anyOf?: JsonSchema[];
  $ref?: string;
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  default?: unknown;
  description?: string;
  title?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

export type ParamHelp = {
  name: string;
  type: string;
  required: boolean;
  /** JSON of the default, if there is one. */
  default?: string;
  description?: string;
  /** "≥ 2", "> 0, < 1" */
  constraints: string[];
};

const isObject = (value: unknown): value is JsonSchema => typeof value === "object" && value !== null;

const typeName = (schema: JsonSchema): string => {
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.anyOf) return schema.anyOf.map(typeName).join(" | ");
  if (schema.$ref) return schema.$ref.split("/").at(-1) ?? "object";
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type === "array") return `${schema.items ? typeName(schema.items) : "any"}[]`;
  return schema.type ?? "any";
};

const constraintsOf = (schema: JsonSchema): string[] => {
  const found = [
    schema.minimum === undefined ? null : `≥ ${schema.minimum}`,
    schema.exclusiveMinimum === undefined ? null : `> ${schema.exclusiveMinimum}`,
    schema.maximum === undefined ? null : `≤ ${schema.maximum}`,
    schema.exclusiveMaximum === undefined ? null : `< ${schema.exclusiveMaximum}`,
    schema.minLength === undefined ? null : `at least ${schema.minLength} characters`,
    schema.maxLength === undefined ? null : `at most ${schema.maxLength} characters`,
    schema.pattern === undefined ? null : `matches ${schema.pattern}`,
  ].filter((entry): entry is string => entry !== null);
  // Optional params are `anyOf: [{ type, constraints }, { type: "null" }]`.
  return [...found, ...(schema.anyOf ?? []).flatMap(constraintsOf)];
};

const propertiesOf = (schema: unknown): [string, JsonSchema][] => {
  const properties = isObject(schema) ? schema.properties : undefined;
  return properties === undefined
    ? []
    : Object.entries(properties).filter((entry): entry is [string, JsonSchema] => isObject(entry[1]));
};

/** One entry per top-level param, in the schema's order. */
export const describeParams = (schema: unknown): ParamHelp[] => {
  const required = new Set(isObject(schema) ? (schema.required ?? []) : []);
  return propertiesOf(schema).map(([name, property]) => ({
    name,
    type: typeName(property),
    required: required.has(name),
    ...("default" in property ? { default: JSON.stringify(property.default) } : {}),
    ...(property.description ? { description: property.description } : {}),
    constraints: constraintsOf(property),
  }));
};

/** The params with every default filled in, as a starting point. */
export const defaultParams = (schema: unknown): Record<string, unknown> =>
  Object.fromEntries(
    propertiesOf(schema)
      .filter(([, property]) => "default" in property)
      .map(([name, property]) => [name, property.default]),
  );

/** The editor's text as a params object, or why it isn't one. */
export const parseParams = (text: string): { params: Record<string, unknown> } | { error: string } => {
  if (text.trim() === "") return { params: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return { error: `Not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "Params must be a JSON object, such as {}." };
  }
  return { params: value as Record<string, unknown> };
};

export const formatParams = (params: unknown) => JSON.stringify(params, null, 2);
