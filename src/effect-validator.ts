import { Result, Schema, SchemaIssue } from "effect";
import type { ValidationTargets } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";

const formatSchemaIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Validates a Hono request input with an Effect Schema.
 *
 * The decoded value is available through `c.req.valid(target)`. Invalid input
 * raises an HTTP 400 response containing every schema issue.
 */
export function effectValidator<
  Target extends keyof ValidationTargets,
  S extends Schema.ConstraintDecoder<unknown>,
>(target: Target, schema: S, options: { readonly onExcessProperty?: "error" } = {}) {
  const decode = Schema.decodeUnknownResult(schema, { errors: "all", ...options });

  return validator(target, (value, c): S["Type"] => {
    const result = decode(value);

    if (Result.isFailure(result)) {
      const issues = formatSchemaIssue(result.failure.issue).issues.map(
        (issue) => ({
          message: issue.message,
          path: issue.path?.map(String),
        }),
      );

      throw new HTTPException(400, {
        res: c.json(
          {
            error: "Request validation failed",
            issues,
          },
          400,
        ),
      });
    }

    return result.success;
  });
}
