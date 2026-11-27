import { Context, type Effect } from "effect";

import type { StepSpec, Subject, WorkflowError } from "$/workflows/contracts";
import type { RunContext } from "$/workflows/registry";

import type {
  DependencyWait,
  RunFilter,
  RunTrigger,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "./contracts";

/** A request to claim an assignment's active-run slot. */
export interface ClaimRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly subject: Subject;
  readonly processingDate: string;
  readonly trigger: RunTrigger;
  readonly rerunOf: string | null;
  /**
   * The schedule occurrence a scheduled run claims (ISO whole UTC hour);
   * null for a manual run. An assignment claims each occurrence once.
   */
  readonly scheduledFor: string | null;
  readonly now: string;
}

/**
 * What a claim recorded: a new `queued` or `skipped` run (`claimed`), or,
 * when the assignment had already claimed the occurrence, that earlier run.
 */
export interface ClaimOutcome {
  readonly run: WorkflowRunSummary;
  readonly claimed: boolean;
}

/** An enabled assignment whose latest due occurrence it has not claimed. */
export interface DueAssignment {
  readonly workflowId: string;
  readonly subject: Subject;
  readonly scheduledFor: string;
}

/**
 * What a run executes: its context and the definition's steps as captured
 * when the run was claimed. `workflowId` names the definition the run came
 * from, which steps record as the producer of what they publish; `steps` is
 * the frozen copy the run executes, which can differ from the definition's
 * current steps once it is edited, and outlives its deletion. The rest of
 * the definition (schedule, scope, enabled) does not affect execution, so
 * it is not captured.
 */
export interface CapturedRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly context: RunContext;
  readonly steps: readonly StepSpec[];
}

/**
 * Injectable persistence for run records and step outcomes. Records are
 * operational history for the API and app; Cloudflare Workflows checkpoints
 * stay the durable execution state. Every write tolerates being repeated, so
 * a retried step body can record its outcome again.
 */
export class WorkflowRunStore extends Context.Service<
  WorkflowRunStore,
  {
    /**
     * Atomically claim the assignment's one active-run slot and capture the
     * definition. Records a `queued` run, or a `skipped` one when another run
     * of the assignment is active; for a schedule occurrence the assignment
     * already claimed, records nothing and returns the earlier run.
     * `not_found` for an unknown definition or assignment; `conflict` when
     * the definition, assignment or asset is disabled (nothing is recorded
     * then).
     */
    readonly claim: (
      input: ClaimRun,
    ) => Effect.Effect<ClaimOutcome, WorkflowError>;
    /**
     * Enabled assignments (of enabled definitions and, for assets, enabled
     * assets) that have not claimed their definition's occurrence, given the
     * occurrence for each UTC hour (index 0–23). Ordered by occurrence,
     * workflow ID, subject kind and subject ID, at most `limit`, after the
     * optional last selected assignment (even if it was not claimed).
     */
    readonly due: (
      occurrenceByHour: readonly string[],
      limit: number,
      after?: DueAssignment,
    ) => Effect.Effect<readonly DueAssignment[], WorkflowError>;
    readonly get: (
      runId: string,
    ) => Effect.Effect<WorkflowRunDetail, WorkflowError>;
    /** Runs, newest first. */
    readonly list: (
      filter: RunFilter,
    ) => Effect.Effect<readonly WorkflowRunSummary[], WorkflowError>;
    /** The assignment's active runs (at most one), for reconciliation. */
    readonly active: (
      workflowId: string,
      subject: Subject,
    ) => Effect.Effect<readonly WorkflowRunSummary[], WorkflowError>;
    /** Active runs by creation time and ID, at most `limit`, after a cursor. */
    readonly allActive: (
      limit: number,
      after?: Pick<WorkflowRunSummary, "createdAt" | "id">,
    ) => Effect.Effect<readonly WorkflowRunSummary[], WorkflowError>;
    /**
     * Mark an active run `running` and return what it executes, or null when
     * the run is gone or no longer active.
     */
    readonly start: (
      runId: string,
      now: string,
    ) => Effect.Effect<CapturedRun | null, WorkflowError>;
    /** Record that a step's body started another attempt. */
    readonly stepStarted: (input: {
      readonly runId: string;
      readonly stepId: string;
      readonly position: number;
      readonly type: string;
      readonly now: string;
    }) => Effect.Effect<void, WorkflowError>;
    /** Record a failed attempt; `final` marks the step failed. */
    readonly stepFailed: (input: {
      readonly runId: string;
      readonly stepId: string;
      readonly error: string;
      readonly final: boolean;
      readonly now: string;
    }) => Effect.Effect<void, WorkflowError>;
    readonly stepWaiting: (input: {
      readonly runId: string;
      readonly stepId: string;
      readonly waiting: DependencyWait;
    }) => Effect.Effect<void, WorkflowError>;
    readonly stepCompleted: (input: {
      readonly runId: string;
      readonly stepId: string;
      readonly outputs: Readonly<Record<string, unknown>>;
      readonly now: string;
      readonly resumesRun?: boolean;
    }) => Effect.Effect<void, WorkflowError>;
    /** Complete an active run. False when it was no longer active. */
    readonly complete: (
      runId: string,
      now: string,
    ) => Effect.Effect<boolean, WorkflowError>;
    /**
     * Fail an active run with a diagnostic, and the given step if it has not
     * completed. False when it was no longer active.
     */
    readonly fail: (input: {
      readonly runId: string;
      readonly error: string;
      readonly stepId?: string;
      readonly now: string;
    }) => Effect.Effect<boolean, WorkflowError>;
  }
>()("data-service/WorkflowRunStore") {}
