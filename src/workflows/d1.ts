import { Effect, Layer } from "effect";

import {
  type StepSpec,
  type Subject,
  subjectId,
  type WorkflowAssignment,
  type WorkflowDefinition,
  WorkflowError,
  type WorkflowSpec,
  type WorkflowSummary,
} from "$/workflows/contracts";
import { Workflows } from "$/workflows/store";

/** Private `workflow_definitions` row; `steps_json` holds the ordered steps. */
interface DefinitionRow {
  readonly workflow_id: string;
  readonly name: string;
  readonly scope: "asset" | "portfolio";
  readonly enabled: number;
  readonly schedule_hour_utc: number;
  readonly steps_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Private list projection with step and assignment counts. */
interface SummaryRow extends DefinitionRow {
  readonly step_count: number;
  readonly assignment_count: number;
}

/** Private `workflow_assignments` row joined with its definition's name. */
interface AssignmentRow {
  readonly workflow_id: string;
  readonly workflow_name: string;
  readonly subject_kind: "asset" | "portfolio";
  readonly subject_id: string;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const toDefinition = (row: DefinitionRow): WorkflowDefinition => ({
  id: row.workflow_id,
  name: row.name,
  scope: row.scope,
  enabled: row.enabled === 1,
  schedule: { hourUtc: row.schedule_hour_utc },
  // Written only from validated specifications.
  steps: JSON.parse(row.steps_json) as StepSpec[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toSummary = (row: SummaryRow): WorkflowSummary => ({
  id: row.workflow_id,
  name: row.name,
  scope: row.scope,
  enabled: row.enabled === 1,
  schedule: { hourUtc: row.schedule_hour_utc },
  stepCount: row.step_count,
  assignmentCount: row.assignment_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toAssignment = (row: AssignmentRow): WorkflowAssignment => ({
  workflowId: row.workflow_id,
  workflowName: row.workflow_name,
  subject:
    row.subject_kind === "asset"
      ? { kind: "asset", symbol: row.subject_id }
      : { kind: "portfolio", id: row.subject_id },
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const query = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () =>
      new WorkflowError({
        kind: "database",
        message: "Could not access workflow definitions",
      }),
  });

const fail = (kind: WorkflowError["kind"], message: string) =>
  Effect.fail(new WorkflowError({ kind, message }));

const definitionNotFound = () =>
  fail("not_found", "The workflow definition does not exist");

const describe = (subject: Subject) =>
  subject.kind === "asset"
    ? `asset ${subject.symbol}`
    : `portfolio ${subject.id}`;

const notAssigned = (subject: Subject) =>
  fail("not_found", `The workflow is not assigned to ${describe(subject)}`);

const ASSIGNMENT_SELECT = `SELECT a.*, d.name AS workflow_name
  FROM workflow_assignments a
  JOIN workflow_definitions d USING (workflow_id)`;

/** Whether the subject exists, as an SQL expression over ?2 (kind) and ?3 (ID). */
const SUBJECT_EXISTS = `(
  (?2 = 'asset' AND EXISTS (SELECT 1 FROM assets WHERE symbol = ?3))
  OR (?2 = 'portfolio' AND EXISTS (SELECT 1 FROM portfolios WHERE portfolio_id = ?3))
)`;

export const D1WorkflowsLive = (db: D1Database): Layer.Layer<Workflows> => {
  const selectAssignment = (workflowId: string, subject: Subject) =>
    db
      .prepare(
        `${ASSIGNMENT_SELECT}
         WHERE a.workflow_id = ? AND a.subject_kind = ? AND a.subject_id = ?`,
      )
      .bind(workflowId, subject.kind, subjectId(subject));

  const assignmentOrNotFound = (
    rows: readonly AssignmentRow[] | undefined,
    subject: Subject,
  ) => {
    const row = rows?.[0];
    return row === undefined
      ? notAssigned(subject)
      : Effect.succeed(toAssignment(row));
  };

  return Layer.succeed(
    Workflows,
    Workflows.of({
      list: () =>
        query(() =>
          db
            .prepare(
              `SELECT d.*,
                 json_array_length(d.steps_json) AS step_count,
                 (SELECT count(*) FROM workflow_assignments a
                  WHERE a.workflow_id = d.workflow_id) AS assignment_count
               FROM workflow_definitions d
               ORDER BY d.name, d.workflow_id`,
            )
            .all<SummaryRow>(),
        ).pipe(Effect.map(({ results }) => results.map(toSummary))),

      get: (id) =>
        query(() =>
          db
            .prepare(`SELECT * FROM workflow_definitions WHERE workflow_id = ?`)
            .bind(id)
            .first<DefinitionRow>(),
        ).pipe(
          Effect.flatMap((row) =>
            row === null
              ? definitionNotFound()
              : Effect.succeed(toDefinition(row)),
          ),
        ),

      create: (id, spec, now) =>
        query(() =>
          db
            .prepare(
              `INSERT INTO workflow_definitions
                 (workflow_id, name, scope, enabled, schedule_hour_utc, steps_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING *`,
            )
            .bind(
              id,
              spec.name,
              spec.scope,
              Number(spec.enabled),
              spec.schedule.hourUtc,
              JSON.stringify(spec.steps),
              now,
              now,
            )
            .first<DefinitionRow>(),
        ).pipe(Effect.map((row) => toDefinition(row!))),

      // One conditional statement: the scope only changes without assignments.
      replace: (id, spec, now) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `UPDATE workflow_definitions SET
                   name = ?2, scope = ?3, enabled = ?4, schedule_hour_utc = ?5,
                   steps_json = ?6, updated_at = ?7
                 WHERE workflow_id = ?1
                   AND (scope = ?3 OR NOT EXISTS (
                     SELECT 1 FROM workflow_assignments WHERE workflow_id = ?1))
                 RETURNING *`,
              )
              .bind(
                id,
                spec.name,
                spec.scope,
                Number(spec.enabled),
                spec.schedule.hourUtc,
                JSON.stringify(spec.steps),
                now,
              ),
            db
              .prepare(
                `SELECT count(*) AS n FROM workflow_definitions WHERE workflow_id = ?`,
              )
              .bind(id),
          ]),
        ).pipe(
          Effect.flatMap(([updated, existing]) => {
            const row = (updated?.results as DefinitionRow[] | undefined)?.[0];
            if (row !== undefined) return Effect.succeed(toDefinition(row));
            const exists =
              (existing?.results as { n: number }[] | undefined)?.[0]?.n === 1;
            return exists
              ? fail(
                  "conflict",
                  "The scope can't change while the workflow has assignments; remove them first",
                )
              : definitionNotFound();
          }),
        ),

      remove: (id) =>
        query(() =>
          db.batch([
            db
              .prepare(`DELETE FROM workflow_assignments WHERE workflow_id = ?`)
              .bind(id),
            db
              .prepare(
                `DELETE FROM workflow_definitions WHERE workflow_id = ? RETURNING workflow_id`,
              )
              .bind(id),
          ]),
        ).pipe(
          Effect.flatMap(([, deleted]) =>
            (deleted?.results.length ?? 0) === 0
              ? definitionNotFound()
              : Effect.void,
          ),
        ),

      listAssignments: (filter) =>
        query(() =>
          db
            .prepare(
              `${ASSIGNMENT_SELECT}
               WHERE (?1 IS NULL OR a.workflow_id = ?1)
                 AND (?2 IS NULL OR (a.subject_kind = ?2 AND a.subject_id = ?3))
               ORDER BY d.name, a.workflow_id, a.subject_kind, a.subject_id`,
            )
            .bind(
              filter.workflowId ?? null,
              filter.subject?.kind ?? null,
              filter.subject === undefined ? null : subjectId(filter.subject),
            )
            .all<AssignmentRow>(),
        ).pipe(Effect.map(({ results }) => results.map(toAssignment))),

      // Inserted only for an existing subject of the definition's scope; when
      // nothing is inserted, a second read explains why.
      assign: (workflowId, subject, enabled, now) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `INSERT INTO workflow_assignments
                   (workflow_id, subject_kind, subject_id, enabled, created_at, updated_at)
                 SELECT d.workflow_id, ?2, ?3, ?4, ?5, ?5
                 FROM workflow_definitions d
                 WHERE d.workflow_id = ?1 AND d.scope = ?2 AND ${SUBJECT_EXISTS}
                 ON CONFLICT DO NOTHING
                 RETURNING workflow_id`,
              )
              .bind(
                workflowId,
                subject.kind,
                subjectId(subject),
                Number(enabled),
                now,
              ),
            db
              .prepare(
                `SELECT d.scope, ${SUBJECT_EXISTS} AS subject_exists
                 FROM workflow_definitions d WHERE d.workflow_id = ?1`,
              )
              .bind(workflowId, subject.kind, subjectId(subject)),
            selectAssignment(workflowId, subject),
          ]),
        ).pipe(
          Effect.flatMap(([inserted, check, assignment]) => {
            if ((inserted?.results.length ?? 0) > 0)
              return assignmentOrNotFound(
                assignment?.results as AssignmentRow[],
                subject,
              );
            const definition = (
              check?.results as
                { scope: string; subject_exists: number }[] | undefined
            )?.[0];
            if (definition === undefined) return definitionNotFound();
            if (definition.scope !== subject.kind)
              return fail(
                "invalid",
                `A ${definition.scope} workflow can't be assigned to a ${subject.kind}`,
              );
            if (definition.subject_exists !== 1)
              return fail("invalid", `The ${describe(subject)} does not exist`);
            return fail(
              "conflict",
              `The workflow is already assigned to ${describe(subject)}`,
            );
          }),
        ),

      setAssignmentEnabled: (workflowId, subject, enabled, now) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `UPDATE workflow_assignments SET enabled = ?, updated_at = ?
                 WHERE workflow_id = ? AND subject_kind = ? AND subject_id = ?`,
              )
              .bind(
                Number(enabled),
                now,
                workflowId,
                subject.kind,
                subjectId(subject),
              ),
            selectAssignment(workflowId, subject),
          ]),
        ).pipe(
          Effect.flatMap(([, assignment]) =>
            assignmentOrNotFound(
              assignment?.results as AssignmentRow[],
              subject,
            ),
          ),
        ),

      unassign: (workflowId, subject) =>
        query(() =>
          db
            .prepare(
              `DELETE FROM workflow_assignments
               WHERE workflow_id = ? AND subject_kind = ? AND subject_id = ?
               RETURNING workflow_id`,
            )
            .bind(workflowId, subject.kind, subjectId(subject))
            .all(),
        ).pipe(
          Effect.flatMap(({ results }) =>
            results.length === 0 ? notAssigned(subject) : Effect.void,
          ),
        ),
    }),
  );
};
