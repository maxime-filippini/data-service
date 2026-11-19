-- Migration number: 0011

-- The current publication of each dataset for each subject: which run of
-- which workflow published it, for which processing date, and what was
-- written. The data itself is an object in the processed bucket at a stable
-- location derived from the dataset and subject (for prices_eod:
-- dataset=prices_eod/symbol=<SYMBOL>/data.parquet), independent of the
-- expiring run artifact it was copied from. A row is written only after the
-- object write succeeded, and replaced by the next publication.
-- There are deliberately no foreign keys: deleting an asset, portfolio or
-- workflow definition keeps its published datasets and their metadata.
CREATE TABLE dataset_publications (
  dataset TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('asset', 'portfolio')),
  subject_id TEXT NOT NULL,
  processing_date TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  -- The run artifact that was copied (it expires; the copy does not).
  source_artifact TEXT NOT NULL,
  format TEXT NOT NULL,
  schema TEXT NOT NULL,
  -- What the object write returned.
  etag TEXT NOT NULL,
  size INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (dataset, subject_kind, subject_id)
);

CREATE INDEX dataset_publications_by_subject
  ON dataset_publications (subject_kind, subject_id);

CREATE INDEX dataset_publications_by_run ON dataset_publications (run_id);
