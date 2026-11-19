import { Effect, Layer } from "effect";

import {
  type StepSpec,
  type Subject,
  subjectId,
  WorkflowError,
} from "$/workflows/contracts";

import type {
  StepOutcome,
  StepOutcomeStatus,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from "./contracts";
import {
  type CapturedRun,
  type ClaimOutcome,
  type DueAssignment,
  WorkflowRuns,
} from "./store";

/** Private `workflow_runs` row. */
interface RunRow {
  readonly run_id: string;
  readonly workflow_id: string;
  readonly workflow_name: string;
  readonly subject_kind: "asset" | "portfolio";
  readonly subject_id: string;
  readonly processing_date: string;
  readonly trigger: "manual" | "schedule";
  readonly rerun_of: string | null;
  readonly scheduled_for: string | null;
  readonly status: WorkflowRunStatus;
  readonly error: string | null;
  readonly steps_json: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

/** Private `workflow_run_steps` row. */
interface StepRow {
  readonly step_id: string;
  readonly position: number;
  readonly step_type: string;
  readonly status: "running" | "waiting" | "completed" | "failed";
  readonly attempts: number;
  readonly outputs_json: string | null;
  readonly error: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

const ACTIVE = `('queued', 'running', 'waiting')`;

const isActive = (status: WorkflowRunStatus) =>
  status === "queued" || status === "running" || status === "waiting";

const subjectOf = (row: RunRow): Subject =>
  row.subject_kind === "asset"
    ? { kind: "asset", symbol: row.subject_id }
    : { kind: "portfolio", id: row.subject_id };

const toSummary = (row: RunRow): WorkflowRunSummary => ({
  id: row.run_id,
  workflowId: row.workflow_id,
  workflowName: row.workflow_name,
  subject: subjectOf(row),
  processingDate: row.processing_date,
  trigger: row.trigger,
  rerunOf: row.rerun_of,
  scheduledFor: row.scheduled_for,
  status: row.status,
  error: row.error,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

// Written only from validated specifications at claim time.
const capturedSteps = (row: RunRow) => JSON.parse(row.steps_json) as StepSpec[];

/** Every captured step in order, with its recorded outcome if it has one. */
const toDetail = (
  row: RunRow,
  stepRows: readonly StepRow[],
): WorkflowRunDetail => {
  const recorded = new Map(stepRows.map((step) => [step.step_id, step]));
  const unreached: StepOutcomeStatus = isActive(row.status)
    ? "pending"
    : "skipped";
  const steps = capturedSteps(row).map((spec, index): StepOutcome => {
    const step = recorded.get(spec.id);
    if (step === undefined)
      return {
        position: index + 1,
        id: spec.id,
        type: spec.type,
        status: unreached,
        attempts: 0,
        outputs: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      };
    return {
      position: step.position,
      id: step.step_id,
      type: step.step_type,
      status: step.status,
      attempts: step.attempts,
      outputs:
        step.outputs_json === null
          ? null
          : (JSON.parse(step.outputs_json) as Record<string, unknown>),
      error: step.error,
      startedAt: step.started_at,
      finishedAt: step.finished_at,
    };
  });
  return { ...toSummary(row), steps };
};

const query = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () =>
      new WorkflowError({
        kind: "database",
        message: "Could not access workflow runs",
      }),
  });

const fail = (kind: WorkflowError["kind"], message: string) =>
  Effect.fail(new WorkflowError({ kind, message }));

const describe = (subject: Subject) =>
  subject.kind === "asset"
    ? `asset ${subject.symbol}`
    : `portfolio ${subject.id}`;

/**
 * The assignment row (alias `a`) and its definition (`d`) can run now: both
 * enabled and, for an asset, the asset enabled.
 */
const RUNNABLE = `a.enabled = 1 AND d.enabled = 1
  AND (a.subject_kind <> 'asset' OR EXISTS (
    SELECT 1 FROM assets s WHERE s.symbol = a.subject_id AND s.enabled = 1))`;

/** `RUNNABLE` for one assignment, over ?2 (workflow), ?3 (kind), ?4 (ID). */
const ELIGIBLE = `a.workflow_id = ?2 AND a.subject_kind = ?3 AND a.subject_id = ?4
  AND ${RUNNABLE}`;

/** The run (`r`) is of the assignment `a`. */
const OF_ASSIGNMENT = `r.workflow_id = a.workflow_id
  AND r.subject_kind = a.subject_kind AND r.subject_id = a.subject_id`;

const RUN_COLUMNS = `run_id, workflow_id, workflow_name, subject_kind, subject_id,
  processing_date, trigger, rerun_of, scheduled_for, status, error, steps_json,
  created_at, finished_at`;

/** Why a claim recorded nothing, over ?1 (workflow), ?2 (kind), ?3 (ID). */
interface EligibilityRow {
  readonly definition_enabled: number;
  readonly assignment_enabled: number | null;
  readonly subject_enabled: number | null;
}

export const D1WorkflowRunsLive = (db: D1Database): Layer.Layer<WorkflowRuns> =>
  Layer.succeed(
    WorkflowRuns,
    WorkflowRuns.of({
      // One batch, one transaction: claim the slot, or record a skip when
      // another run holds it, then explain whichever happened. The unique
      // indexes make the queued insert a no-op when the slot is taken or the
      // occurrence was already claimed; the skip insert then checks both.
      claim: (input) =>
        query(() => {
          const values = [
            input.runId,
            input.workflowId,
            input.subject.kind,
            subjectId(input.subject),
            input.processingDate,
            input.trigger,
            input.rerunOf,
            input.now,
            input.scheduledFor,
          ];
          return db.batch([
            db
              .prepare(
                `INSERT INTO workflow_runs (${RUN_COLUMNS})
                 SELECT ?1, d.workflow_id, d.name, a.subject_kind, a.subject_id,
                   ?5, ?6, ?7, ?9, 'queued', NULL, d.steps_json, ?8, NULL
                 FROM workflow_assignments a
                 JOIN workflow_definitions d ON d.workflow_id = a.workflow_id
                 WHERE ${ELIGIBLE}
                 ON CONFLICT DO NOTHING`,
              )
              .bind(...values),
            db
              .prepare(
                `INSERT INTO workflow_runs (${RUN_COLUMNS})
                 SELECT ?1, d.workflow_id, d.name, a.subject_kind, a.subject_id,
                   ?5, ?6, ?7, ?9, 'skipped',
                   'Run ' || r.run_id || ' of this assignment was still ' || r.status,
                   d.steps_json, ?8, ?8
                 FROM workflow_assignments a
                 JOIN workflow_definitions d ON d.workflow_id = a.workflow_id
                 JOIN workflow_runs r ON ${OF_ASSIGNMENT} AND r.status IN ${ACTIVE}
                 WHERE ${ELIGIBLE}
                   AND NOT EXISTS (SELECT 1 FROM workflow_runs x WHERE x.run_id = ?1)
                   AND NOT EXISTS (SELECT 1 FROM workflow_runs x
                     WHERE x.workflow_id = ?2 AND x.subject_kind = ?3
                       AND x.subject_id = ?4 AND x.scheduled_for = ?9)
                 LIMIT 1`,
              )
              .bind(...values),
            db
              .prepare(
                `SELECT d.enabled AS definition_enabled,
                   a.enabled AS assignment_enabled,
                   CASE WHEN ?2 = 'asset'
                     THEN (SELECT enabled FROM assets WHERE symbol = ?3)
                     ELSE 1 END AS subject_enabled
                 FROM workflow_definitions d
                 LEFT JOIN workflow_assignments a ON a.workflow_id = d.workflow_id
                   AND a.subject_kind = ?2 AND a.subject_id = ?3
                 WHERE d.workflow_id = ?1`,
              )
              .bind(
                input.workflowId,
                input.subject.kind,
                subjectId(input.subject),
              ),
            db
              .prepare(`SELECT * FROM workflow_runs WHERE run_id = ?`)
              .bind(input.runId),
            db
              .prepare(
                `SELECT * FROM workflow_runs
                 WHERE ?4 IS NOT NULL AND workflow_id = ?1 AND subject_kind = ?2
                   AND subject_id = ?3 AND scheduled_for = ?4`,
              )
              .bind(
                input.workflowId,
                input.subject.kind,
                subjectId(input.subject),
                input.scheduledFor,
              ),
          ]);
        }).pipe(
          Effect.flatMap(
            ([, , eligibility, recorded, occurrence]): Effect.Effect<
              ClaimOutcome,
              WorkflowError
            > => {
              const run = (recorded?.results as RunRow[] | undefined)?.[0];
              if (run !== undefined)
                return Effect.succeed({ run: toSummary(run), claimed: true });
              const earlier = (
                occurrence?.results as RunRow[] | undefined
              )?.[0];
              if (earlier !== undefined)
                return Effect.succeed({
                  run: toSummary(earlier),
                  claimed: false,
                });
              const check = (
                eligibility?.results as EligibilityRow[] | undefined
              )?.[0];
              if (check === undefined)
                return fail(
                  "not_found",
                  "The workflow definition does not exist",
                );
              if (check.assignment_enabled === null)
                return fail(
                  "not_found",
                  `The workflow is not assigned to ${describe(input.subject)}`,
                );
              if (check.definition_enabled !== 1)
                return fail(
                  "conflict",
                  "The workflow definition is disabled; enable it to run it",
                );
              if (check.assignment_enabled !== 1)
                return fail(
                  "conflict",
                  `The assignment to ${describe(input.subject)} is disabled; enable it to run it`,
                );
              if (check.subject_enabled !== 1)
                return fail(
                  "conflict",
                  `The ${describe(input.subject)} is disabled; enable it to run it`,
                );
              return fail("database", "Could not record the run");
            },
          ),
        ),

      get: (runId) =>
        query(() =>
          db.batch([
            db
              .prepare(`SELECT * FROM workflow_runs WHERE run_id = ?`)
              .bind(runId),
            db
              .prepare(
                `SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY position`,
              )
              .bind(runId),
          ]),
        ).pipe(
          Effect.flatMap(([run, steps]) => {
            const row = (run?.results as RunRow[] | undefined)?.[0];
            return row === undefined
              ? fail("not_found", "The run does not exist")
              : Effect.succeed(
                  toDetail(row, (steps?.results ?? []) as StepRow[]),
                );
          }),
        ),

      list: (filter) =>
        query(() =>
          db
            .prepare(
              `SELECT * FROM workflow_runs
               WHERE (?1 IS NULL OR workflow_id = ?1)
                 AND (?2 IS NULL OR subject_kind = ?2)
                 AND (?3 IS NULL OR subject_id = ?3)
                 AND (?4 IS NULL OR status = ?4)
                 AND (?6 IS NULL OR trigger = ?6)
               ORDER BY created_at DESC, run_id DESC
               LIMIT ?5`,
            )
            .bind(
              filter.workflowId ?? null,
              filter.subject?.kind ?? null,
              filter.subject?.id ?? null,
              filter.status ?? null,
              filter.limit,
              filter.trigger ?? null,
            )
            .all<RunRow>(),
        ).pipe(Effect.map(({ results }) => results.map(toSummary))),

      active: (workflowId, subject) =>
        query(() =>
          db
            .prepare(
              `SELECT * FROM workflow_runs
               WHERE workflow_id = ? AND subject_kind = ? AND subject_id = ?
                 AND status IN ${ACTIVE}`,
            )
            .bind(workflowId, subject.kind, subjectId(subject))
            .all<RunRow>(),
        ).pipe(Effect.map(({ results }) => results.map(toSummary))),

      allActive: (limit) =>
        query(() =>
          db
            .prepare(
              `SELECT * FROM workflow_runs WHERE status IN ${ACTIVE}
               ORDER BY created_at, run_id LIMIT ?`,
            )
            .bind(limit)
            .all<RunRow>(),
        ).pipe(Effect.map(({ results }) => results.map(toSummary))),

      // Each enabled definition's occurrence is the entry for its hour in
      // the JSON array ?1; claimed occurrences are excluded by the same
      // column the claim's unique index covers.
      due: (occurrenceByHour, limit) =>
        query(() =>
          db
            .prepare(
              `SELECT a.workflow_id, a.subject_kind, a.subject_id, o.scheduled_for
               FROM (
                 SELECT workflow_id,
                   json_extract(?1, '$[' || schedule_hour_utc || ']') AS scheduled_for
                 FROM workflow_definitions WHERE enabled = 1
               ) o
               JOIN workflow_definitions d ON d.workflow_id = o.workflow_id
               JOIN workflow_assignments a ON a.workflow_id = d.workflow_id
               WHERE ${RUNNABLE}
                 AND NOT EXISTS (SELECT 1 FROM workflow_runs r
                   WHERE ${OF_ASSIGNMENT} AND r.scheduled_for = o.scheduled_for)
               ORDER BY o.scheduled_for, d.name, a.workflow_id, a.subject_kind, a.subject_id
               LIMIT ?2`,
            )
            .bind(JSON.stringify(occurrenceByHour), limit)
            .all<{
              workflow_id: string;
              subject_kind: "asset" | "portfolio";
              subject_id: string;
              scheduled_for: string;
            }>(),
        ).pipe(
          Effect.map(({ results }) =>
            results.map((row): DueAssignment => ({
              workflowId: row.workflow_id,
              subject:
                row.subject_kind === "asset"
                  ? { kind: "asset", symbol: row.subject_id }
                  : { kind: "portfolio", id: row.subject_id },
              scheduledFor: row.scheduled_for,
            })),
          ),
        ),

      start: (runId, now) =>
        query(() =>
          db
            .prepare(
              `UPDATE workflow_runs SET
                 status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
                 started_at = coalesce(started_at, ?2)
               WHERE run_id = ?1 AND status IN ${ACTIVE}
               RETURNING *`,
            )
            .bind(runId, now)
            .first<RunRow>(),
        ).pipe(
          Effect.map((row): CapturedRun | null =>
            row === null
              ? null
              : {
                  runId: row.run_id,
                  workflowId: row.workflow_id,
                  context: {
                    subject: subjectOf(row),
                    processingDate: row.processing_date,
                  },
                  steps: capturedSteps(row),
                },
          ),
        ),

      stepStarted: (input) =>
        query(() =>
          db
            .prepare(
              `INSERT INTO workflow_run_steps
                 (run_id, step_id, position, step_type, status, attempts, started_at)
               VALUES (?1, ?2, ?3, ?4, 'running', 1, ?5)
               ON CONFLICT (run_id, step_id) DO UPDATE SET
                 status = 'running', attempts = attempts + 1,
                 outputs_json = NULL, finished_at = NULL`,
            )
            .bind(
              input.runId,
              input.stepId,
              input.position,
              input.type,
              input.now,
            )
            .run(),
        ).pipe(Effect.asVoid),

      stepFailed: (input) =>
        query(() =>
          db
            .prepare(
              `UPDATE workflow_run_steps SET
                 error = ?3,
                 status = CASE WHEN ?4 = 1 THEN 'failed' ELSE status END,
                 finished_at = CASE WHEN ?4 = 1 THEN ?5 ELSE finished_at END
               WHERE run_id = ?1 AND step_id = ?2`,
            )
            .bind(
              input.runId,
              input.stepId,
              input.error,
              Number(input.final),
              input.now,
            )
            .run(),
        ).pipe(Effect.asVoid),

      stepCompleted: (input) =>
        query(() =>
          db
            .prepare(
              `UPDATE workflow_run_steps SET
                 status = 'completed', outputs_json = ?3, error = NULL, finished_at = ?4
               WHERE run_id = ?1 AND step_id = ?2`,
            )
            .bind(
              input.runId,
              input.stepId,
              JSON.stringify(input.outputs),
              input.now,
            )
            .run(),
        ).pipe(Effect.asVoid),

      complete: (runId, now) =>
        query(() =>
          db
            .prepare(
              `UPDATE workflow_runs SET status = 'completed', error = NULL, finished_at = ?2
               WHERE run_id = ?1 AND status IN ${ACTIVE}
               RETURNING run_id`,
            )
            .bind(runId, now)
            .first(),
        ).pipe(Effect.map((row) => row !== null)),

      fail: (input) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `UPDATE workflow_run_steps SET
                   status = 'failed',
                   error = coalesce(error, ?3),
                   finished_at = coalesce(finished_at, ?4)
                 WHERE run_id = ?1 AND step_id = ?2 AND status <> 'completed'
                   AND EXISTS (SELECT 1 FROM workflow_runs
                     WHERE run_id = ?1 AND status IN ${ACTIVE})`,
              )
              .bind(input.runId, input.stepId ?? null, input.error, input.now),
            db
              .prepare(
                `UPDATE workflow_runs SET status = 'failed', error = ?2, finished_at = ?3
                 WHERE run_id = ?1 AND status IN ${ACTIVE}
                 RETURNING run_id`,
              )
              .bind(input.runId, input.error, input.now),
          ]),
        ).pipe(Effect.map(([, run]) => (run?.results.length ?? 0) > 0)),
    }),
  );
