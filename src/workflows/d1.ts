import { and, eq, notExists, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect, Layer } from "effect";

import { d1Query } from "$/d1";
import {
  assets,
  portfolios,
  workflowAssignments,
  workflowDefaults,
} from "$/db/schema";
import {
  type StepSpec,
  type Subject,
  type SubjectKind,
  type WorkflowAssignment,
  type WorkflowDefault,
  type WorkflowDefinition,
  WorkflowError,
  type WorkflowSpec,
  type WorkflowSummary,
} from "$/workflows/contracts";
import { WorkflowStore } from "$/workflows/store";
import { SUBJECT_KINDS, subjectId, subjectOf } from "$/workflows/subjects";

/** Private `workflow_definitions` row; `steps_json` holds the ordered steps. */
interface DefinitionRow {
  readonly workflow_id: string;
  readonly name: string;
  readonly scope: SubjectKind;
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

/** Private `workflow_assignments` row joined with its definition. */
interface AssignmentRow {
  readonly workflow_id: string;
  readonly workflow_name: string;
  readonly workflow_enabled: number;
  readonly schedule_hour_utc: number;
  readonly subject_kind: SubjectKind;
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

/** Private `workflow_defaults` row joined with its definition. */
interface DefaultRow {
  readonly subject_kind: SubjectKind;
  readonly workflow_id: string;
  readonly workflow_name: string;
  readonly workflow_enabled: number;
  readonly schedule_hour_utc: number;
  readonly created_at: string;
}

const toAssignment = (row: AssignmentRow): WorkflowAssignment => ({
  workflowId: row.workflow_id,
  workflowName: row.workflow_name,
  workflowEnabled: row.workflow_enabled === 1,
  schedule: { hourUtc: row.schedule_hour_utc },
  subject: subjectOf(row.subject_kind, row.subject_id),
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toDefault = (row: DefaultRow): WorkflowDefault => ({
  subjectKind: row.subject_kind,
  workflowId: row.workflow_id,
  workflowName: row.workflow_name,
  workflowEnabled: row.workflow_enabled === 1,
  schedule: { hourUtc: row.schedule_hour_utc },
  createdAt: row.created_at,
});

const query = d1Query(
  () =>
    new WorkflowError({
      kind: "database",
      message: "Could not access workflow definitions",
    }),
);

const fail = (kind: WorkflowError["kind"], message: string) =>
  Effect.fail(new WorkflowError({ kind, message }));

const definitionNotFound = () =>
  fail("not_found", "The workflow definition does not exist");

const describe = (subject: Subject) => `${subject.kind} ${subjectId(subject)}`;

const notAssigned = (subject: Subject) =>
  fail("not_found", `The workflow is not assigned to ${describe(subject)}`);

/** The table holding each subject kind, and its identifier column. */
const subjectTables = {
  asset: { table: "assets", id: "symbol" },
  portfolio: { table: "portfolios", id: "portfolio_id" },
} as const satisfies Record<
  SubjectKind,
  { readonly table: string; readonly id: string }
>;

/**
 * Whether a subject exists, as an SQL expression over the given kind and ID
 * parameters (such as `?2` and `?3`).
 */
const subjectExists = (kind: string, id: string) =>
  `(${SUBJECT_KINDS.map(
    (k) =>
      `(${kind} = '${k}' AND EXISTS (SELECT 1 FROM ${subjectTables[k].table} WHERE ${subjectTables[k].id} = ${id}))`,
  ).join(" OR ")})`;

const ASSIGNMENT_SELECT = `SELECT a.*, d.name AS workflow_name,
    d.enabled AS workflow_enabled, d.schedule_hour_utc
  FROM workflow_assignments a
  JOIN workflow_definitions d USING (workflow_id)`;

const DEFAULT_SELECT = `SELECT f.subject_kind, f.workflow_id, f.created_at,
    d.name AS workflow_name, d.enabled AS workflow_enabled, d.schedule_hour_utc
  FROM workflow_defaults f
  JOIN workflow_definitions d USING (workflow_id)`;

/** Every subject of the kind ?1, as `subjects(id)`. */
const SUBJECTS_OF_KIND = `subjects (id) AS (${SUBJECT_KINDS.map(
  (k) =>
    `SELECT ${subjectTables[k].id} FROM ${subjectTables[k].table} WHERE ?1 = '${k}'`,
).join(" UNION ALL ")})`;

/**
 * The statement that gives a subject its kind's default assignments, enabled,
 * when the subject is created. Put it in the same batch as, and before, the
 * statement inserting the subject: it only assigns while the subject does not
 * exist yet, so a rejected duplicate creation assigns nothing, and the batch
 * makes subject and assignments appear together.
 */
export const assignDefaultsOnCreate = (
  orm: DrizzleD1Database,
  subject: Subject,
  now: string,
) => {
  const id = subjectId(subject);
  const existing =
    subject.kind === "asset"
      ? orm
          .select({ one: sql`1` })
          .from(assets)
          .where(eq(assets.symbol, id))
      : orm
          .select({ one: sql`1` })
          .from(portfolios)
          .where(eq(portfolios.portfolioId, id));
  return orm
    .insert(workflowAssignments)
    .select(
      orm
        .select({
          workflowId: workflowDefaults.workflowId,
          subjectKind: workflowDefaults.subjectKind,
          subjectId: sql`${id}`.as("subject_id"),
          enabled: sql`1`.as("enabled"),
          createdAt: sql`${now}`.as("created_at"),
          updatedAt: sql`${now}`.as("updated_at"),
        })
        .from(workflowDefaults)
        .where(
          and(
            eq(workflowDefaults.subjectKind, subject.kind),
            notExists(existing),
          ),
        ),
    )
    .onConflictDoNothing();
};

/** Whether the subject exists, over ?2 (kind) and ?3 (ID). */
const SUBJECT_EXISTS = subjectExists("?2", "?3");

/** Active workflow runs (alias `r`), to be narrowed with `AND ...`. */
const ACTIVE_RUN_FROM = `FROM workflow_runs r
  WHERE r.status IN ('queued', 'running', 'waiting')`;

/** An active-run subquery body, for `NOT EXISTS (...)`. */
const ACTIVE_RUN = `SELECT 1 ${ACTIVE_RUN_FROM}`;

/** The run (`r`) is of the assignment over ?1 (workflow), ?2 (kind), ?3 (ID). */
const SAME_ASSIGNMENT = `r.workflow_id = ?1 AND r.subject_kind = ?2 AND r.subject_id = ?3`;

export const D1WorkflowStoreLive = (
  db: D1Database,
): Layer.Layer<WorkflowStore> => {
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
    WorkflowStore,
    WorkflowStore.of({
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

      // One conditional statement: the scope only changes without assignments
      // or default links.
      replace: (id, spec, now) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `UPDATE workflow_definitions SET
                   name = ?2, scope = ?3, enabled = ?4, schedule_hour_utc = ?5,
                   steps_json = ?6, updated_at = ?7
                 WHERE workflow_id = ?1
                   AND (scope = ?3 OR (
                     NOT EXISTS (SELECT 1 FROM workflow_assignments WHERE workflow_id = ?1)
                     AND NOT EXISTS (SELECT 1 FROM workflow_defaults WHERE workflow_id = ?1)))
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
                  "The scope can't change while the workflow has assignments or is a default; remove them first",
                )
              : definitionNotFound();
          }),
        ),

      // Blocked while a run of the definition is active; run history stays.
      remove: (id) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `DELETE FROM workflow_defaults
                 WHERE workflow_id = ?1 AND NOT EXISTS (${ACTIVE_RUN} AND r.workflow_id = ?1)`,
              )
              .bind(id),
            db
              .prepare(
                `DELETE FROM workflow_assignments
                 WHERE workflow_id = ?1 AND NOT EXISTS (${ACTIVE_RUN} AND r.workflow_id = ?1)`,
              )
              .bind(id),
            db
              .prepare(
                `DELETE FROM workflow_definitions
                 WHERE workflow_id = ?1 AND NOT EXISTS (${ACTIVE_RUN} AND r.workflow_id = ?1)
                 RETURNING workflow_id`,
              )
              .bind(id),
            db
              .prepare(
                `SELECT r.run_id ${ACTIVE_RUN_FROM} AND r.workflow_id = ?1 LIMIT 1`,
              )
              .bind(id),
          ]),
        ).pipe(
          Effect.flatMap(([, , deleted, active]) => {
            if ((deleted?.results.length ?? 0) > 0) return Effect.void;
            const run = (
              active?.results as { run_id: string }[] | undefined
            )?.[0];
            return run === undefined
              ? definitionNotFound()
              : fail(
                  "conflict",
                  `Run ${run.run_id} of this workflow is still active; delete the workflow once it finishes`,
                );
          }),
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

      // Blocked while the assignment has an active run; run history stays.
      unassign: (workflowId, subject) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `DELETE FROM workflow_assignments
                 WHERE workflow_id = ?1 AND subject_kind = ?2 AND subject_id = ?3
                   AND NOT EXISTS (${ACTIVE_RUN} AND ${SAME_ASSIGNMENT})
                 RETURNING workflow_id`,
              )
              .bind(workflowId, subject.kind, subjectId(subject)),
            db
              .prepare(
                `SELECT r.run_id ${ACTIVE_RUN_FROM} AND ${SAME_ASSIGNMENT} LIMIT 1`,
              )
              .bind(workflowId, subject.kind, subjectId(subject)),
          ]),
        ).pipe(
          Effect.flatMap(([deleted, active]) => {
            if ((deleted?.results.length ?? 0) > 0) return Effect.void;
            const run = (
              active?.results as { run_id: string }[] | undefined
            )?.[0];
            return run === undefined
              ? notAssigned(subject)
              : fail(
                  "conflict",
                  `Run ${run.run_id} of this assignment is still active; remove the assignment once it finishes`,
                );
          }),
        ),

      listDefaults: (kind) =>
        query(() =>
          db
            .prepare(
              `${DEFAULT_SELECT}
               WHERE ?1 IS NULL OR f.subject_kind = ?1
               ORDER BY f.subject_kind, d.name, f.workflow_id`,
            )
            .bind(kind ?? null)
            .all<DefaultRow>(),
        ).pipe(Effect.map(({ results }) => results.map(toDefault))),

      // Only a definition of the kind's scope; when nothing is there
      // afterwards, the scope read explains why.
      addDefault: (kind, workflowId, now) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `INSERT INTO workflow_defaults (subject_kind, workflow_id, created_at)
                 SELECT ?1, workflow_id, ?3 FROM workflow_definitions
                 WHERE workflow_id = ?2 AND scope = ?1
                 ON CONFLICT DO NOTHING`,
              )
              .bind(kind, workflowId, now),
            db
              .prepare(
                `${DEFAULT_SELECT} WHERE f.subject_kind = ? AND f.workflow_id = ?`,
              )
              .bind(kind, workflowId),
            db
              .prepare(
                `SELECT scope FROM workflow_definitions WHERE workflow_id = ?`,
              )
              .bind(workflowId),
          ]),
        ).pipe(
          Effect.flatMap(([, saved, definition]) => {
            const row = (saved?.results as DefaultRow[] | undefined)?.[0];
            if (row !== undefined) return Effect.succeed(toDefault(row));
            const scope = (
              definition?.results as { scope: SubjectKind }[] | undefined
            )?.[0]?.scope;
            return scope === undefined
              ? definitionNotFound()
              : fail(
                  "invalid",
                  `${scope === "asset" ? "An" : "A"} ${scope} workflow can't be a ${kind} default`,
                );
          }),
        ),

      removeDefault: (kind, workflowId) =>
        query(() =>
          db
            .prepare(
              `DELETE FROM workflow_defaults
               WHERE subject_kind = ? AND workflow_id = ?
               RETURNING workflow_id`,
            )
            .bind(kind, workflowId)
            .first(),
        ).pipe(
          Effect.flatMap((row) =>
            row === null
              ? fail("not_found", `The workflow is not a ${kind} default`)
              : Effect.void,
          ),
        ),

      // One batch: insert what is missing (never touching an existing,
      // possibly disabled, assignment), then read the views of what was added.
      applyDefaults: (kind, now) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `WITH ${SUBJECTS_OF_KIND}
                 INSERT INTO workflow_assignments
                   (workflow_id, subject_kind, subject_id, enabled, created_at, updated_at)
                 SELECT f.workflow_id, f.subject_kind, s.id, 1, ?2, ?2
                 FROM workflow_defaults f, subjects s
                 WHERE f.subject_kind = ?1
                 ON CONFLICT DO NOTHING
                 RETURNING workflow_id, subject_id`,
              )
              .bind(kind, now),
            db
              .prepare(
                `${ASSIGNMENT_SELECT}
                 WHERE a.subject_kind = ?1 AND a.created_at = ?2
                   AND a.workflow_id IN (
                     SELECT workflow_id FROM workflow_defaults WHERE subject_kind = ?1)
                 ORDER BY d.name, a.workflow_id, a.subject_id`,
              )
              .bind(kind, now),
          ]),
        ).pipe(
          Effect.map(([inserted, candidates]) => {
            const added = new Set(
              (
                (inserted?.results ?? []) as {
                  workflow_id: string;
                  subject_id: string;
                }[]
              ).map((row) => `${row.workflow_id}\u0000${row.subject_id}`),
            );
            return ((candidates?.results ?? []) as AssignmentRow[])
              .filter((row) =>
                added.has(`${row.workflow_id}\u0000${row.subject_id}`),
              )
              .map(toAssignment);
          }),
        ),
    }),
  );
};
