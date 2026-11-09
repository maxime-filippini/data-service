---
title: Portfolios
description: Named series of dated holdings snapshots that calculations run over.
---

A **portfolio** is a name and a series of **holdings snapshots**. A snapshot is
a holdings date and a list of `(symbol, weight)`: the holdings at the close of
that date. It stays in effect until the next snapshot. The service stores
snapshots, not trades or changes between them.

## Single-asset portfolios

Registering a `prices_eod` symbol also creates a portfolio named after it, with
one snapshot on `1900-01-01` holding the symbol at weight 1, in the same D1
batch as the registration. Re-registering leaves it alone. Migration `0008`
creates these portfolios for symbols registered before the migration.

The API returns `assetSymbol` (the symbol for a single-asset portfolio, `null`
for a normal one). Single-asset portfolios cannot be renamed, deleted or given
other snapshots; those changes return `409`. The app labels them and lets you
hide them from the list.

## Which snapshot is in effect

```mermaid
gantt
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  title Snapshots of portfolio Core
  section Snapshots
  Sep 30 snapshot (AAPL 60%, MSFT 40%) :s1, 2026-09-30, 2026-10-15
  Oct 15 snapshot (AAPL 100%)          :s2, 2026-10-15, 2026-10-31
  section Runs
  as of Oct 10 uses Sep 30 :milestone, m1, 2026-10-10, 0d
  as of Oct 15 uses Oct 15 :milestone, m2, 2026-10-15, 0d
  as of Oct 20 uses Oct 15 :milestone, m3, 2026-10-20, 0d
```

- A run for as-of date **D** sees the snapshots dated **on or before D**, never
  later ones. A snapshot dated D counts for D itself.
- If a portfolio has no snapshot on or before D, only that portfolio fails; the
  other portfolios of the run still complete.
- Each calculation type picks the snapshots it needs: `holdings_at(date)` for
  one date (ex-ante volatility), or `snapshots_between(start, end)` for every
  snapshot over a period (realised P&L).

## Rules

- **Symbols.** Every symbol must be a tracked symbol in `prices_eod` (disabled
  symbols count). A foreign key from holdings to `tracked_symbols` keeps a held
  symbol from being deleted.
- **Weights.** Any non-zero numbers. Shorts and leverage are allowed, and they
  don't need to sum to 1. Each type normalises or checks them as it needs.
- **One per date.** A portfolio has at most one snapshot per holdings date;
  snapshots are addressed by that date.
- **No edits.** Snapshots can be added or deleted, not edited. To correct one,
  delete it and add it again. Earlier results aren't rewritten; types that
  depend on one snapshot (like `ex_ante_vol`) record its holdings date in their
  results.
- **Deleting.** Deleting a portfolio that a calculation uses returns `409` with
  the calculations that use it. Disabling a held symbol is allowed: its Parquet
  file stays, so calculations keep working on its old data. A future symbol-delete
  route will need to delete the symbol's single-asset portfolio first.

```mermaid
erDiagram
  portfolios ||--o{ portfolio_snapshots : has
  portfolio_snapshots ||--|{ portfolio_holdings : contains
  tracked_symbols ||--o{ portfolio_holdings : "held as"
  portfolios ||--o{ calculation_portfolios : "used by"
```

## API

```sh
# Create one, optionally with its first snapshot
curl -X POST "$URL/api/portfolios" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Core","snapshot":{"holdingsDate":"2026-09-30","holdings":[{"symbol":"AAPL.US","weight":0.6},{"symbol":"MSFT.US","weight":0.4}]}}'

# Add a snapshot, or delete the one for a date
curl -X POST "$URL/api/portfolios/$ID/snapshots" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"holdingsDate":"2026-10-15","holdings":[{"symbol":"AAPL.US","weight":1}]}'
curl -X DELETE "$URL/api/portfolios/$ID/snapshots/2026-10-15" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Untracked symbols return `400` with their list in `symbols`; a second snapshot
for the same date, or a change to a single-asset portfolio, returns `409`.
The full route list is in the
[API reference](/docs/reference/api/#portfolios).
