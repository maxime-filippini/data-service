-- Migration number: 0003

-- Newest runs first, for the dashboard's run history.
CREATE INDEX ingestion_runs_recent ON ingestion_runs (created_at, run_id);

-- A symbol's latest run, whatever its status.
CREATE INDEX ingestion_runs_by_symbol ON ingestion_runs (dataset, symbol, created_at, run_id);

-- A symbol's latest processing job.
CREATE INDEX processing_jobs_by_symbol ON processing_jobs (dataset, symbol, created_at, job_id);
