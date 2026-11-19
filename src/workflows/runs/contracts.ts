/**
 * Workflow run request schemas and the platform seam. Expected failures use
 * `WorkflowError`; response types live in `views.ts`.
 */

import { Schema } from "effect";

import { MarketDateSchema } from "$/market-data/schemas";
import {
  SubjectKindSchema,
  SubjectSchema,
  WorkflowIdSchema,
} from "$/workflows/contracts";

import type { ActiveRunStatus, WorkflowRunStatus } from "./views";

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

/** Which runs to list, newest first. */
export interface RunFilter {
  readonly workflowId?: string;
  readonly subject?: { readonly kind: string; readonly id?: string };
  readonly status?: WorkflowRunStatus;
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

export type * from "./views";
