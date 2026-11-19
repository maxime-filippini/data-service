-- Operational view of a dependency wait. The execution deadline itself is
-- captured by the Workflow's durable checkpoint.
ALTER TABLE workflow_run_steps ADD COLUMN waiting_json TEXT
  CHECK (waiting_json IS NULL OR json_valid(waiting_json));

CREATE INDEX workflow_runs_completed_asset_dependencies
  ON workflow_runs (workflow_id, subject_id, processing_date, finished_at)
  WHERE subject_kind = 'asset' AND status = 'completed';
