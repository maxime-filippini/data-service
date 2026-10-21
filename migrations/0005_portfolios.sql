-- Migration number: 0005

-- A named series of holdings snapshots that calculations run over.
CREATE TABLE portfolios (
  portfolio_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A portfolio's holdings at the close of holdings_date, in effect until its
-- next snapshot. Snapshots are added or deleted, never edited.
CREATE TABLE portfolio_snapshots (
  portfolio_id TEXT NOT NULL REFERENCES portfolios (portfolio_id) ON DELETE CASCADE,
  holdings_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (portfolio_id, holdings_date)
);

-- One position in a snapshot. The symbol must be tracked in prices_eod, so the
-- foreign key also stops a held symbol from leaving the registry.
CREATE TABLE portfolio_holdings (
  portfolio_id TEXT NOT NULL,
  holdings_date TEXT NOT NULL,
  dataset TEXT NOT NULL CHECK (dataset = 'prices_eod'),
  symbol TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight != 0),
  PRIMARY KEY (portfolio_id, holdings_date, symbol),
  FOREIGN KEY (portfolio_id, holdings_date)
    REFERENCES portfolio_snapshots (portfolio_id, holdings_date) ON DELETE CASCADE,
  FOREIGN KEY (dataset, symbol) REFERENCES tracked_symbols (dataset, symbol)
);

-- Which portfolios hold a symbol.
CREATE INDEX portfolio_holdings_by_symbol ON portfolio_holdings (dataset, symbol);
