---
title: Ingestion
description: How a symbol's history is downloaded, validated and stored raw.
---

An **ingestion run** downloads a symbol's full history from its provider and
stores the validated response once, as an immutable object in the
`raw-market-data` bucket. Runs come from the [daily schedule](/docs/pipeline/schedule/)
or from `POST /ingestions`.

## Flow

```mermaid
sequenceDiagram
  autonumber
  participant C as Caller<br/>(API, dashboard, Workflow)
  participant W as Worker
  participant Q as Ingestion queue
  participant QC as Ingestion consumer
  participant D1
  participant P as Provider (EODHD)
  participant R2 as R2 raw-market-data
  participant PQ as Processing queue

  C->>W: POST /ingestions {entries}
  W->>D1: check every entry is registered
  W->>Q: one message per symbol<br/>(end date fixed = previous UTC day)
  W-->>C: 202 queued entries + date ranges

  Q->>QC: batch (up to 5 messages)
  QC->>D1: look up provider + backfillStartDate
  QC->>D1: insert ingestion_runs (fetching)
  Note over QC,D1: skipped if the symbol<br/>already has a fetching run
  QC->>P: download full history
  QC->>QC: validate rows
  QC->>R2: put run=<run-id>.json
  QC->>D1: mark run completed (key, etag, row count)
  QC->>D1: create processing job (queued)
  QC->>PQ: send {jobId}
  Note over QC,PQ: if the symbol already has an active job,<br/>this run waits for the daily cron sweep
```

The message fixes the snapshot's **end date** (the previous UTC day), so a
retry downloads exactly the same range.

## Rules

- **One download at a time per symbol.** Starting a run is skipped if the
  symbol already has a `fetching` run; the partial unique index
  `ingestion_runs_one_fetching` backs this up. A `fetching` run older than 30
  minutes is assumed dead and failed first.
- **Fresh run per delivery.** Each queue delivery gets a new run ID.
- **Retries.** Provider request, storage and database errors retry the message (3
  times, 60 seconds apart, then the DLQ). Bad configuration, invalid provider
  data and unregistered symbols are acknowledged without retry.

```mermaid
flowchart LR
  err{Error kind?}
  err -- request / storage / database --> retry[message.retry<br/>up to 3×]
  retry --> dlq[(market-data-ingestion-dlq)]
  err -- configuration / invalid data / unregistered --> ack[message.ack<br/>no retry]
```

## Run states

```mermaid
stateDiagram-v2
  [*] --> fetching
  fetching --> completed: raw object stored
  fetching --> failed: provider or validation error
  fetching --> failed: older than 30 min (assumed dead)
```

## Raw envelope

Each completed run writes one JSON object at
`raw-market-data/dataset=<dataset>/symbol=<symbol>/run=<run-id>.json`:

```json
{
  "version": 1,
  "runId": "…",
  "dataset": "prices_eod",
  "provider": "eodhd",
  "symbol": "AAPL.US",
  "requestedRange": { "from": "2016-01-01", "to": "2026-10-05" },
  "receivedAt": "…",
  "entries": []
}
```

## Datasets and providers

Identity is `(dataset, symbol)`. The provider is a setting on each tracked
symbol that picks the download adapter, so switching vendor doesn't move the
Parquet file. The allowed combinations live in `datasetProviders` in
`src/market-data/schemas.ts`.

To add a dataset (for example FRED rates):

1. Add it to `DatasetSchema` / `ProviderSchema` and `datasetProviders`.
2. Write a `MarketDataSource` adapter that validates the provider's rows.
3. Add the entry model and Parquet schema in the processor.
