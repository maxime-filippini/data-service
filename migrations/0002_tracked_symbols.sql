CREATE TABLE tracked_symbols (
  symbol TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  backfill_start_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (symbol, provider),
  CHECK ((enabled = 1 AND disabled_at IS NULL) OR
         (enabled = 0 AND disabled_at IS NOT NULL))
);

CREATE INDEX tracked_symbols_enabled_symbol_provider ON tracked_symbols (enabled, symbol, provider);
