// Workflow runs and their step outcomes as the API returns them. Like the
// other views files, this imports only types from other views files
// (relatively), so the app can import its types directly.

import type { SubjectView } from "../views";

/**
 * Where a run is. `queued`: claimed, its Workflow instance launched or
 * launching. `running`: executing its steps. `waiting`: in a durable wait
 * for upstream data. `completed` and `failed` are final. `skipped`: never
 * ran, because another run of the same assignment was active (for a
 * scheduled run, when its occurrence was due).
 */
export type WorkflowRunStatus =
  "queued" | "running" | "waiting" | "completed" | "failed" | "skipped";

/** The statuses that hold an assignment's one active-run slot. */
export type ActiveRunStatus = "queued" | "running" | "waiting";

/**
 * Where one step of a run is. `pending`: not reached yet. `running`:
 * executing or retrying (with the last attempt's error, if any). `skipped`:
 * never reached because the run ended first.
 */
export type StepOutcomeStatus =
  "pending" | "running" | "waiting" | "completed" | "failed" | "skipped";

/** What started a run. */
export type RunTrigger = "manual" | "schedule";

/**
 * One run of a definition for one subject and processing date. The
 * workflow name and subject are recorded with the run, so history stays
 * readable after the definition or subject is deleted.
 */
export interface WorkflowRunSummary {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly subject: SubjectView;
  readonly processingDate: string;
  readonly trigger: RunTrigger;
  /** The run this one reruns from the beginning, if any. */
  readonly rerunOf: string | null;
  /**
   * For a scheduled run, the daily occurrence (a whole UTC hour) it was
   * dispatched for; its processing date is that occurrence's UTC date.
   * Null for manual runs.
   */
  readonly scheduledFor: string | null;
  readonly status: WorkflowRunStatus;
  /** Why the run failed or was skipped. */
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** One step of a run's captured definition, with its outcome so far. */
export interface StepOutcome {
  /** 1-based position in the execution order. */
  readonly position: number;
  readonly id: string;
  readonly type: string;
  readonly status: StepOutcomeStatus;
  /** How many times its body started; above 1 means it was retried. */
  readonly attempts: number;
  /**
   * The step's small named outputs once completed. Large data appears as
   * artifact references (`{ id, format, schema }`), never inline.
   */
  readonly outputs: Readonly<Record<string, unknown>> | null;
  /** The latest attempt's error. */
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** A run with every step of its captured definition, in order. */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  readonly steps: readonly StepOutcome[];
}
