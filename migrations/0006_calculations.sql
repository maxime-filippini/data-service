-- Migration number: 0006

-- A saved calculation: a type from the engine, its params (stored as the
-- engine returned them, with defaults filled in), a 5-field UTC cron
-- expression and an enabled flag. The type can't change. Results go to
-- calculation=<calculation_id>/data.parquet in the processed bucket.
CREATE TABLE calculations (
  calculation_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The portfolios a calculation runs over, in order. The foreign key stops a
-- portfolio in use from being deleted.
CREATE TABLE calculation_portfolios (
  calculation_id TEXT NOT NULL REFERENCES calculations (calculation_id) ON DELETE CASCADE,
  portfolio_id TEXT NOT NULL REFERENCES portfolios (portfolio_id),
  position INTEGER NOT NULL,
  PRIMARY KEY (calculation_id, portfolio_id)
);

-- Which calculations use a portfolio.
CREATE INDEX calculation_portfolios_by_portfolio ON calculation_portfolios (portfolio_id);

-- One run of a calculation for one as-of date, started by its cron or by
-- hand, with the params it used. A run started while another was running is
-- recorded as skipped. portfolios_json holds each portfolio's outcome.
CREATE TABLE calculation_runs (
  run_id TEXT PRIMARY KEY,
  calculation_id TEXT NOT NULL REFERENCES calculations (calculation_id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  as_of TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed', 'skipped')),
  portfolios_json TEXT CHECK (portfolios_json IS NULL OR json_valid(portfolios_json)),
  row_count INTEGER,
  output_etag TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

-- A calculation's runs, newest first.
CREATE INDEX calculation_runs_by_calculation ON calculation_runs (calculation_id, created_at);

-- Only one run per calculation at a time.
CREATE UNIQUE INDEX calculation_runs_one_running
  ON calculation_runs (calculation_id)
  WHERE status = 'running';
