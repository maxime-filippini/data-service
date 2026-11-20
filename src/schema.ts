/**
 * Effect Schema helpers shared across features: reusable checks, collecting
 * and describing every issue of a value at a path, and JSON Schema export.
 */

import { Result, Schema, SchemaIssue } from "effect";

import { utcDay } from "$/datetime";

/** A `YYYY-MM-DD` date check: the date is today (UTC) or earlier. */
export const isNotFutureDate = (message: string) =>
  Schema.makeFilter<string>((date) => date <= utcDay(new Date()) || message);

/** One problem with a value, at a path into its JSON. */
export interface ValueIssue {
  readonly path: readonly string[];
  readonly message: string;
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Validate `value` against `schema`, rejecting unknown keys. Succeeds with
 * the decoded value, or fails with every issue, each with its path prefixed
 * by `path`.
 */
export const validateValue = <A>(
  schema: Schema.Codec<A, unknown>,
  value: unknown,
  path: readonly string[] = [],
): Result.Result<A, readonly ValueIssue[]> =>
  Result.mapError(
    Schema.decodeUnknownResult(schema, {
      errors: "all",
      onExcessProperty: "error",
    })(value),
    (failure) =>
      formatIssue(failure.issue).issues.map((issue) => ({
        path: [...path, ...(issue.path ?? []).map(String)],
        message: issue.message,
      })),
  );

/**
 * Issues as one diagnostic: `path: message` for each issue at a path, the
 * bare message otherwise, separated by semicolons.
 */
export const describeIssues = (issues: readonly ValueIssue[]): string =>
  issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");

/**
 * Validate `value` against `schema` like `validateValue`, failing with one
 * diagnostic that describes every issue.
 */
export const validateValueDescribed = <A>(
  schema: Schema.Codec<A, unknown>,
  value: unknown,
): Result.Result<A, string> =>
  Result.mapError(validateValue(schema, value), describeIssues);

/**
 * A schema as one JSON Schema (draft 2020-12) object, with any shared
 * definitions under `$defs`.
 */
export const toJsonSchema = (
  schema: Schema.Top,
): Readonly<Record<string, unknown>> => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};
