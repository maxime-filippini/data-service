-- Migration number: 0013

-- A snapshot can contain workflow assets and legacy registry positions.
-- Existing holdings keep their original foreign keys during the transition.
CREATE TABLE portfolio_asset_holdings (
  portfolio_id TEXT NOT NULL,
  holdings_date TEXT NOT NULL,
  symbol TEXT NOT NULL REFERENCES assets (symbol),
  weight REAL NOT NULL CHECK (weight != 0),
  PRIMARY KEY (portfolio_id, holdings_date, symbol),
  FOREIGN KEY (portfolio_id, holdings_date)
    REFERENCES portfolio_snapshots (portfolio_id, holdings_date) ON DELETE CASCADE
);

CREATE INDEX portfolio_asset_holdings_by_symbol ON portfolio_asset_holdings (symbol);
