-- Migration number: 0008

-- A single-asset portfolio holds only asset_symbol, at weight 1 from
-- 1900-01-01. Registering a prices_eod symbol creates its portfolio, which
-- can't be renamed, deleted or given other snapshots.
ALTER TABLE portfolios ADD COLUMN asset_symbol TEXT;

CREATE UNIQUE INDEX portfolios_one_per_asset ON portfolios (asset_symbol) WHERE asset_symbol IS NOT NULL;

-- Backfill the symbols registered so far. IDs are random v4 UUIDs.
INSERT INTO portfolios (portfolio_id, name, created_at, updated_at, asset_symbol)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-'
    || substr('89ab', 1 + abs(random() % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-'
    || lower(hex(randomblob(6))),
  symbol,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  symbol
FROM tracked_symbols
WHERE dataset = 'prices_eod';

INSERT INTO portfolio_snapshots (portfolio_id, holdings_date, created_at)
SELECT portfolio_id, '1900-01-01', created_at FROM portfolios WHERE asset_symbol IS NOT NULL;

INSERT INTO portfolio_holdings (portfolio_id, holdings_date, dataset, symbol, weight)
SELECT portfolio_id, '1900-01-01', 'prices_eod', asset_symbol, 1 FROM portfolios WHERE asset_symbol IS NOT NULL;
