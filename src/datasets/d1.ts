import { Effect, Layer } from "effect";

import { d1Query } from "$/d1";
import type { Subject } from "$/workflows/contracts";
import { type SubjectKind, subjectId, subjectOf } from "$/workflows/subjects";

import { DatasetError, type PublicationView } from "./contracts";
import { DatasetPublicationStore } from "./store";

/** Private `dataset_publications` row joined with its run's workflow name. */
interface PublicationRow {
  readonly dataset: string;
  readonly subject_kind: SubjectKind;
  readonly subject_id: string;
  readonly processing_date: string;
  readonly workflow_id: string;
  readonly workflow_name: string | null;
  readonly run_id: string;
  readonly step_id: string;
  readonly format: string;
  readonly schema: string;
  readonly etag: string;
  readonly size: number;
  readonly published_at: string;
}

const fromRow = (row: PublicationRow): PublicationView => ({
  dataset: row.dataset,
  subject: subjectOf(row.subject_kind, row.subject_id),
  processingDate: row.processing_date,
  producer: {
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    runId: row.run_id,
    stepId: row.step_id,
  },
  format: row.format,
  schema: row.schema,
  size: row.size,
  etag: row.etag,
  publishedAt: row.published_at,
});

const query = d1Query(
  () =>
    new DatasetError({
      kind: "database",
      message: "Could not access dataset publications",
    }),
);

const SELECT = `SELECT p.*, r.workflow_name
  FROM dataset_publications p
  LEFT JOIN workflow_runs r ON r.run_id = p.run_id`;

/** Publication metadata in D1 (`dataset_publications`). */
export const D1DatasetPublicationStoreLive = (
  db: D1Database,
): Layer.Layer<DatasetPublicationStore> =>
  Layer.succeed(
    DatasetPublicationStore,
    DatasetPublicationStore.of({
      record: (publication) =>
        query(() =>
          db
            .prepare(
              `INSERT INTO dataset_publications
                 (dataset, subject_kind, subject_id, processing_date,
                  workflow_id, run_id, step_id, source_artifact, format,
                  schema, etag, size, published_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (dataset, subject_kind, subject_id) DO UPDATE SET
                 processing_date = excluded.processing_date,
                 workflow_id = excluded.workflow_id,
                 run_id = excluded.run_id,
                 step_id = excluded.step_id,
                 source_artifact = excluded.source_artifact,
                 format = excluded.format,
                 schema = excluded.schema,
                 etag = excluded.etag,
                 size = excluded.size,
                 published_at = excluded.published_at`,
            )
            .bind(
              publication.dataset,
              publication.subject.kind,
              subjectId(publication.subject),
              publication.processingDate,
              publication.workflowId,
              publication.runId,
              publication.stepId,
              publication.sourceArtifact,
              publication.format,
              publication.schema,
              publication.etag,
              publication.size,
              publication.publishedAt,
            )
            .run(),
        ).pipe(Effect.asVoid),

      list: (filter) => {
        const where: string[] = [];
        const values: string[] = [];
        if (filter.subject !== undefined) {
          where.push("p.subject_kind = ?");
          values.push(filter.subject.kind);
          if (filter.subject.id !== undefined) {
            where.push("p.subject_id = ?");
            values.push(filter.subject.id);
          }
        }
        if (filter.dataset !== undefined) {
          where.push("p.dataset = ?");
          values.push(filter.dataset);
        }
        return query(() =>
          db
            .prepare(
              `${SELECT}
               ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
               ORDER BY p.subject_kind, p.subject_id, p.dataset`,
            )
            .bind(...values)
            .all<PublicationRow>(),
        ).pipe(Effect.map(({ results }) => results.map(fromRow)));
      },

      get: (dataset, subject: Subject) =>
        query(() =>
          db
            .prepare(
              `${SELECT}
               WHERE p.dataset = ? AND p.subject_kind = ? AND p.subject_id = ?`,
            )
            .bind(dataset, subject.kind, subjectId(subject))
            .first<PublicationRow>(),
        ).pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.fail(
                  new DatasetError({
                    kind: "not_found",
                    message: `${dataset} has not been published for ${subjectId(subject)}`,
                  }),
                )
              : Effect.succeed(fromRow(row)),
          ),
        ),

      checkAssetPrices: ({ workflowId, symbols, processingDate, deadline }) =>
        query(() =>
          db
            .prepare(
              `SELECT j.value AS symbol, p.run_id, p.etag,
                 EXISTS (
                   SELECT 1 FROM workflow_runs r
                   WHERE r.workflow_id = ?2 AND r.subject_kind = 'asset'
                     AND r.subject_id = j.value AND r.processing_date = ?3
                     AND r.status = 'completed' AND r.finished_at <= ?4
                 ) AS succeeded,
                 EXISTS (
                   SELECT 1 FROM workflow_runs producer
                   WHERE producer.run_id = p.run_id AND producer.workflow_id = ?2
                     AND producer.subject_kind = 'asset' AND producer.subject_id = j.value
                     AND producer.processing_date = ?3 AND producer.status = 'completed'
                     AND p.workflow_id = ?2 AND p.processing_date = ?3
                     AND producer.finished_at <= ?4 AND p.published_at <= ?4
                 ) AS publication_matches
               FROM json_each(?1) j
               LEFT JOIN dataset_publications p
                 ON p.dataset = 'prices_eod' AND p.subject_kind = 'asset'
                 AND p.subject_id = j.value
               ORDER BY j.key`,
            )
            .bind(JSON.stringify(symbols), workflowId, processingDate, deadline)
            .all<{
              symbol: string;
              run_id: string | null;
              etag: string;
              succeeded: number;
              publication_matches: number;
            }>(),
        ).pipe(
          Effect.map(({ results }) =>
            results.map((row) => ({
              symbol: row.symbol,
              succeeded: row.succeeded === 1,
              publication:
                row.run_id === null
                  ? null
                  : {
                      runId: row.run_id,
                      etag: row.etag,
                      matches: row.publication_matches === 1,
                    },
            })),
          ),
        ),
    }),
  );
