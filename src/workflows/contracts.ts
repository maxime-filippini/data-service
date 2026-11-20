/**
 * Workflow definition and assignment request schemas, subjects and expected
 * failures. A definition is a complete specification: scope, enabled state,
 * daily UTC hour and an ordered list of uniquely identified steps. These
 * schemas check shape only; `validateWorkflowSpec` checks the steps against
 * the step registry. Response types live in `views.ts`.
 */

import { Effect, Schema } from "effect";

import { AssetSymbolSchema } from "$/assets/contracts";
import { PortfolioIdSchema } from "$/portfolios/contracts";

/** Most steps one definition can have. */
export const MAX_WORKFLOW_STEPS = 50;

/** The kind of subject a definition runs for: its scope. */
export const SubjectKindSchema = Schema.Literals(["asset", "portfolio"]);

/** An asset subject, identified by its symbol. */
export const AssetSubjectSchema = Schema.Struct({
  kind: Schema.Literal("asset"),
  symbol: AssetSymbolSchema,
});

/** A portfolio subject, identified by its ID. */
export const PortfolioSubjectSchema = Schema.Struct({
  kind: Schema.Literal("portfolio"),
  id: PortfolioIdSchema,
});

/**
 * The asset or portfolio a workflow runs for. Also the shape of the run
 * context's `subject` field.
 */
export const SubjectSchema = Schema.Union([
  AssetSubjectSchema,
  PortfolioSubjectSchema,
]);

/** UUID identifying a saved workflow definition. */
export const WorkflowIdSchema = Schema.String.check(Schema.isUUID());

/**
 * A step's identity within its definition. Letters, digits, `_` and `-`, so a
 * reference such as `steps.download.outputs.raw` stays unambiguous.
 */
export const StepIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u, {
    message:
      "Expected a step ID of letters, digits, _ or - starting with a letter",
  }),
);

/** A literal input value, used as given. */
export const LiteralBindingSchema = Schema.Struct({ value: Schema.Unknown });

/**
 * A reference to a run-context field (`context.subject`,
 * `context.processingDate`) or to a named output of an earlier step
 * (`steps.<id>.outputs.<name>`). References are not expressions.
 */
export const ReferenceBindingSchema = Schema.Struct({ ref: Schema.String });

/** How one named step input gets its value. */
export const BindingSchema = Schema.Union([
  LiteralBindingSchema,
  ReferenceBindingSchema,
]);

const emptyRecord = Effect.succeed({});

/**
 * One configured occurrence of a step type. `params` is literal,
 * step-specific configuration; `inputs` binds each named input. Both default
 * to empty objects.
 */
export const StepSpecSchema = Schema.Struct({
  id: StepIdSchema,
  type: Schema.NonEmptyString,
  params: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withDecodingDefaultKey(emptyRecord),
  ),
  inputs: Schema.Record(Schema.String, BindingSchema).pipe(
    Schema.withDecodingDefaultKey(emptyRecord),
  ),
});

/** A definition's daily schedule: one whole UTC hour. */
export const ScheduleSchema = Schema.Struct({
  hourUtc: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
});

/**
 * HTTP input for creating (POST) or replacing (PUT) a whole definition. The
 * list order is the execution order.
 */
export const WorkflowSpecSchema = Schema.Struct({
  name: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  scope: SubjectKindSchema,
  enabled: Schema.Boolean,
  schedule: ScheduleSchema,
  steps: Schema.Array(StepSpecSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_WORKFLOW_STEPS),
  ),
});

/** HTTP input for assigning a definition to a subject. Enabled by default. */
export const AssignSchema = Schema.Struct({
  subject: SubjectSchema,
  enabled: Schema.optionalKey(Schema.Boolean),
});

/** HTTP input for enabling or disabling one assignment. */
export const AssignmentChangeSchema = Schema.Struct({
  enabled: Schema.Boolean,
});

export type SubjectKind = typeof SubjectKindSchema.Type;
export type AssetSubject = typeof AssetSubjectSchema.Type;
export type PortfolioSubject = typeof PortfolioSubjectSchema.Type;
export type Subject = typeof SubjectSchema.Type;
export type Binding = typeof BindingSchema.Type;
export type StepSpec = typeof StepSpecSchema.Type;

/** A decoded, not yet registry-validated, complete specification. */
export type WorkflowSpec = typeof WorkflowSpecSchema.Type;

export type * from "$/workflows/views";

/** A subject's identifier: an asset's symbol or a portfolio's ID. */
export const subjectId = (subject: Subject): string =>
  subject.kind === "asset" ? subject.symbol : subject.id;

/**
 * Expected failure reading or changing definitions and assignments.
 * `invalid` carries every `issues` entry found when validating a
 * specification against the step registry, or explains a rejected
 * assignment; `conflict` is a duplicate assignment or a scope change while
 * assignments exist.
 */
export class WorkflowError extends Schema.TaggedError<WorkflowError>()(
  "WorkflowError",
  {
    kind: Schema.Literals(["database", "not_found", "conflict", "invalid"]),
    message: Schema.String,
    issues: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          path: Schema.Array(Schema.String),
          message: Schema.String,
        }),
      ),
    ),
  },
) {}
