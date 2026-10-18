-- Migration number: 0002

-- Only one download per (dataset, symbol) at a time.
CREATE UNIQUE INDEX ingestion_runs_one_fetching
  ON ingestion_runs (dataset, symbol)
  WHERE status = 'fetching';
