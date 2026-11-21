-- Migration number: 0009

-- An instrument, identified by its (provider-qualified) symbol. Datasets are
-- not part of its identity. Provider and backfill start are its download
-- settings. Creating an asset creates no portfolio.
CREATE TABLE assets (
  symbol TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  backfill_start_date TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A complete workflow specification. The ordered steps, with their
-- heterogeneous params and input bindings, are JSON; identity, scope and
-- scheduling are ordinary columns.
--
-- The scope and subject_kind CHECK lists must match SUBJECT_KINDS in
-- src/workflows/subjects.ts. Changing the kinds needs a migration that
-- rebuilds every table with such a CHECK: SQLite can't alter one.
CREATE TABLE workflow_definitions (
  workflow_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('asset', 'portfolio')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  schedule_hour_utc INTEGER NOT NULL CHECK (schedule_hour_utc BETWEEN 0 AND 23),
  steps_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX workflow_definitions_by_hour
  ON workflow_definitions (schedule_hour_utc)
  WHERE enabled = 1;

-- One definition assigned to one subject (an asset symbol or a portfolio ID)
-- of the definition's scope. Deleting the definition removes its assignments;
-- deleting a subject removes them in the same batch.
CREATE TABLE workflow_assignments (
  workflow_id TEXT NOT NULL
    REFERENCES workflow_definitions (workflow_id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('asset', 'portfolio')),
  subject_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, subject_kind, subject_id)
);

CREATE INDEX workflow_assignments_by_subject
  ON workflow_assignments (subject_kind, subject_id);
