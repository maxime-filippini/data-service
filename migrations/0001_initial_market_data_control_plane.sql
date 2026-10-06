-- Migration number: 0001 	 2026-10-02T09:51:24.977Z

PRAGMA foreign_keys = ON;

CREATE TABLE ingestion_runs (
  run_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  symbol TEXT NOT NULL,
  requested_from TEXT NOT NULL,
  requested_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fetching', 'raw_complete', 'failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  CHECK (requested_from <= requested_to)
);

CREATE INDEX ingestion_runs_ready_by_symbol
  ON ingestion_runs (symbol, completed_at, run_id)
  WHERE status = 'raw_complete';

CREATE TABLE ingestion_run_objects (
  run_id TEXT NOT NULL REFERENCES ingestion_runs (run_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  observed_from TEXT,
  observed_to TEXT,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  PRIMARY KEY (run_id, object_key),
  CHECK (
    observed_from IS NULL
    OR observed_to IS NULL
    OR observed_from <= observed_to
  )
);

CREATE TABLE processing_jobs (
  job_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('merge', 'rebuild')),
  canonical_key TEXT NOT NULL,
  expected_base_etag TEXT,
  transform_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'processing', 'completed', 'failed')
  ),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  output_etag TEXT,
  error TEXT
);

CREATE UNIQUE INDEX processing_jobs_one_active_per_symbol
  ON processing_jobs (symbol)
  WHERE status IN ('queued', 'processing');

CREATE TABLE processing_job_runs (
  job_id TEXT NOT NULL REFERENCES processing_jobs (job_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES ingestion_runs (run_id),
  precedence INTEGER NOT NULL CHECK (precedence >= 0),
  PRIMARY KEY (job_id, run_id),
  UNIQUE (job_id, precedence)
);

CREATE TABLE canonical_datasets (
  symbol TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  object_etag TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  complete_through TEXT,
  active_job_id TEXT REFERENCES processing_jobs (job_id),
  updated_at TEXT
);

CREATE TABLE canonical_run_applications (
  symbol TEXT NOT NULL REFERENCES canonical_datasets (symbol),
  run_id TEXT NOT NULL REFERENCES ingestion_runs (run_id),
  job_id TEXT NOT NULL REFERENCES processing_jobs (job_id),
  canonical_revision INTEGER NOT NULL CHECK (canonical_revision > 0),
  applied_at TEXT NOT NULL,
  PRIMARY KEY (symbol, run_id)
);

CREATE INDEX canonical_run_applications_by_job
  ON canonical_run_applications (job_id);
