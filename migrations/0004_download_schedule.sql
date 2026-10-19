-- Migration number: 0004

-- The single daily download schedule. It starts paused so deploying this
-- doesn't start downloads; unpause it from the dashboard or the API.
CREATE TABLE download_schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hour_utc INTEGER NOT NULL CHECK (hour_utc BETWEEN 0 AND 23),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO download_schedule (id, hour_utc, paused, updated_at)
VALUES (1, 6, 1, '2026-10-19T00:00:00.000Z');

-- One run of the schedule: queues a download for every enabled symbol.
-- run_id is also the Workflow instance ID.
CREATE TABLE schedule_runs (
  run_id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  run_date TEXT NOT NULL,
  snapshot_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  queued_count INTEGER CHECK (queued_count >= 0),
  skipped_count INTEGER CHECK (skipped_count >= 0),
  error TEXT
);

-- The cron starts at most one run per UTC day. Manual runs are extra.
CREATE UNIQUE INDEX schedule_runs_one_per_day
  ON schedule_runs (run_date)
  WHERE trigger = 'schedule';

CREATE INDEX schedule_runs_recent ON schedule_runs (created_at, run_id);
