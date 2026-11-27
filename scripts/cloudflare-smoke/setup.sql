CREATE TABLE IF NOT EXISTS smoke_faults (
  run_id TEXT NOT NULL,
  point TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (run_id, point)
);
