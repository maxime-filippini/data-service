-- Migration number: 0001

-- What to download. Identity is (dataset, symbol); provider picks the adapter.
CREATE TABLE tracked_symbols (
  dataset TEXT NOT NULL,
  symbol TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  backfill_start_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (dataset, symbol)
);

-- One provider download, stored as one immutable raw R2 object.
CREATE TABLE ingestion_runs (
  run_id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  symbol TEXT NOT NULL,
  provider TEXT NOT NULL,
  requested_from TEXT NOT NULL,
  requested_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fetching', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  object_key TEXT,
  object_etag TEXT,
  row_count INTEGER CHECK (row_count >= 0),
  observed_from TEXT,
  observed_to TEXT,
  CHECK (requested_from <= requested_to),
  CHECK (
    status != 'completed'
    OR (object_key IS NOT NULL AND object_etag IS NOT NULL AND row_count IS NOT NULL)
  )
);

CREATE INDEX ingestion_runs_latest_completed
  ON ingestion_runs (dataset, symbol, created_at, run_id)
  WHERE status = 'completed';

-- One rebuild of a canonical Parquet object from one completed run.
CREATE TABLE processing_jobs (
  job_id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  symbol TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES ingestion_runs (run_id),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'processing', 'completed', 'failed')
  ),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  output_etag TEXT,
  error TEXT
);

-- Only one writer per canonical object.
CREATE UNIQUE INDEX processing_jobs_one_active
  ON processing_jobs (dataset, symbol)
  WHERE status IN ('queued', 'processing');

CREATE INDEX processing_jobs_by_run ON processing_jobs (run_id);
