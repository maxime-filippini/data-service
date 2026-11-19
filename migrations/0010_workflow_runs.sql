-- Migration number: 0010

-- One run of a workflow definition for one assigned subject and processing
-- date. The claim captures the definition's name and ordered steps, so an
-- active run keeps its sequence when the definition is edited and the run
-- stays readable after its definition, assignment or subject is deleted.
-- There are deliberately no foreign keys: deleting configuration never
-- deletes run history. The Cloudflare Workflow instance ID is the run ID.
CREATE TABLE workflow_runs (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('asset', 'portfolio')),
  subject_id TEXT NOT NULL,
  processing_date TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  -- The run this one reruns from the beginning, if any.
  rerun_of TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'skipped')
  ),
  error TEXT,
  steps_json TEXT NOT NULL CHECK (json_valid(steps_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

-- Only one active run per assignment. Claims insert against this index, so
-- concurrent submissions cannot both start a run.
CREATE UNIQUE INDEX workflow_runs_one_active
  ON workflow_runs (workflow_id, subject_kind, subject_id)
  WHERE status IN ('queued', 'running', 'waiting');

CREATE INDEX workflow_runs_by_created ON workflow_runs (created_at);

CREATE INDEX workflow_runs_by_workflow
  ON workflow_runs (workflow_id, created_at);

CREATE INDEX workflow_runs_by_subject
  ON workflow_runs (subject_kind, subject_id, created_at);

-- The outcome of each step a run has reached, for inspection. Outputs are the
-- step's small named outputs (artifact references, not artifact contents);
-- Cloudflare Workflows checkpoints remain the durable source for execution.
CREATE TABLE workflow_run_steps (
  run_id TEXT NOT NULL REFERENCES workflow_runs (run_id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('running', 'waiting', 'completed', 'failed')
  ),
  attempts INTEGER NOT NULL,
  outputs_json TEXT CHECK (outputs_json IS NULL OR json_valid(outputs_json)),
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (run_id, step_id)
);
