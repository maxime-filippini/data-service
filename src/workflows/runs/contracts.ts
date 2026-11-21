/**
 * Workflow run domain records, request schemas and the platform seam.
 * Expected failures use `WorkflowError`; response types live in `views.ts`.
 */

import { Schema } from "effect";

import { MarketDateSchema } from "$/market-data/schemas";
import {
  type Subject,
  SubjectKindSchema,
  SubjectSchema,
  WorkflowIdSchema,
} from "$/workflows/contracts";

/** The statuses that hold an assignment's one active-run slot. */
export const ACTIVE_RUN_STATUSES: readonly ActiveRunStatus[] = [
  "queued",
  "running",
  "waiting",
];

export const RunStatusSchema = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "skipped",
]);

export const RunTriggerSchema = Schema.Literals(["manual", "schedule"]);

/** UUID identifying a run; also its Workflow instance ID. */
export const RunIdSchema = Schema.String.check(Schema.isUUID());

/**
 * HTTP input for starting an assignment manually. The processing date
 * defaults to today's UTC date.
 */
export const StartRunSchema = Schema.Struct({
  workflowId: WorkflowIdSchema,
  subject: SubjectSchema,
  processingDate: Schema.optionalKey(MarketDateSchema),
});

/** Most runs one list request returns. */
export const MAX_RUN_LIST = 200;

/** Query filters for listing runs; values stay strings as in the URL. */
export const RunsQuerySchema = Schema.Struct({
  workflowId: Schema.optionalKey(WorkflowIdSchema),
  subjectKind: Schema.optionalKey(SubjectKindSchema),
  subjectId: Schema.optionalKey(Schema.NonEmptyString),
  status: Schema.optionalKey(RunStatusSchema),
  trigger: Schema.optionalKey(RunTriggerSchema),
  limit: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^[1-9]\d*$/u, {
        message: "Expected a positive integer",
      }),
      Schema.makeFilter(
        (value) => Number(value) <= MAX_RUN_LIST || `At most ${MAX_RUN_LIST}`,
      ),
    ),
  ),
});

export type WorkflowRunStatus = typeof RunStatusSchema.Type;
export type ActiveRunStatus = Extract<
  WorkflowRunStatus,
  "queued" | "running" | "waiting"
>;
export type StepOutcomeStatus =
  Exclude<WorkflowRunStatus, "queued"> | "pending";
export type RunTrigger = typeof RunTriggerSchema.Type;

export interface WorkflowRunSummary {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly subject: Subject;
  readonly processingDate: typeof MarketDateSchema.Type;
  readonly trigger: RunTrigger;
  readonly rerunOf: string | null;
  readonly scheduledFor: string | null;
  readonly status: WorkflowRunStatus;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface StepOutcome {
  readonly position: number;
  readonly id: string;
  readonly type: string;
  readonly status: StepOutcomeStatus;
  readonly attempts: number;
  readonly outputs: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  readonly steps: readonly StepOutcome[];
}

/** Which runs to list, newest first. */
export interface RunFilter {
  readonly workflowId?: string;
  readonly subject?: { readonly kind: string; readonly id?: string };
  readonly status?: WorkflowRunStatus;
  readonly trigger?: RunTrigger;
  readonly limit: number;
}

/**
 * Durable payload of a run's Workflow instance. The instance ID equals
 * `runId`; the captured definition and context are loaded from the run
 * record in the instance's first step.
 */
export interface WorkflowRunParams {
  readonly runId: string;
}

/**
 * The Workflow binding subset runs need: launch an instance with a
 * deterministic ID and look one up to reconcile an uncertain launch. Tests
 * and the local fixture command supply an in-process stand-in.
 */
export type RunPlatform = Pick<Workflow<WorkflowRunParams>, "create" | "get">;
