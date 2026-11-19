-- Migration number: 0012

-- The workflow definitions assigned automatically to each new subject of a
-- kind (an asset or a portfolio): one row per default. A definition can only
-- be a default for its own scope. Creating a subject copies these rows into
-- workflow_assignments in the same batch; changing defaults later never
-- touches existing subjects, and applying them to existing subjects is an
-- explicit operation that only adds missing assignments. Deleting the
-- definition removes its default links.
CREATE TABLE workflow_defaults (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('asset', 'portfolio')),
  workflow_id TEXT NOT NULL
    REFERENCES workflow_definitions (workflow_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subject_kind, workflow_id)
);

-- The daily schedule occurrence (a whole UTC hour, ISO 8601) a scheduled run
-- was dispatched for; NULL for manual runs. Each assignment claims an
-- occurrence at most once, whether the run was queued or skipped, so repeated
-- or concurrent hourly ticks cannot dispatch it twice.
ALTER TABLE workflow_runs ADD COLUMN scheduled_for TEXT;

CREATE UNIQUE INDEX workflow_runs_one_per_occurrence
  ON workflow_runs (workflow_id, subject_kind, subject_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL;
