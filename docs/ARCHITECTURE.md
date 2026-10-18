# Architecture

A personal market-data service. It downloads data for a universe of symbols on
a schedule, turns each symbol's history into one Parquet file in R2, and lets
other apps manage the universe. Apps read the Parquet files from R2 directly;
the API never serves market data.

```txt
tracked_symbols ─(daily cron / manual refresh)→ provider API
   → raw R2 object + ingestion run (D1)
   → processing job (D1) → Queue → Worker consumer → Python container
   → canonical Parquet in R2 → job completed (D1)
```

Glossary: [CONTEXT.md](../CONTEXT.md).

## Parts

| Part | Role |
| --- | --- |
| Worker | Management API, provider downloads, raw storage, all D1 state, queue consumer that drives the container. |
| D1 | Universe (`tracked_symbols`), `ingestion_runs`, `processing_jobs`. No market data. |
| `raw-market-data` (R2) | Immutable validated provider responses, one per run. |
| Python container ([data-service-processor](https://github.com/maxime-filippini/data-service-processor)) | Reads one raw object, writes one Parquet object, returns its ETag. No D1 access, no callbacks. |
| `processed-market-data` (R2) | One Parquet object per `(dataset, symbol)`. This is what apps read. |

## Storage layout

```txt
raw-market-data/dataset=<dataset>/symbol=<symbol>/run=<run-id>.json
processed-market-data/dataset=<dataset>/symbol=<symbol>/data.parquet
```

The raw envelope (version 1):

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

Adding a dataset (for example FRED rates):

1. Add it to `DatasetSchema`/`ProviderSchema` and `datasetProviders`.
2. Write a `MarketDataSource` adapter that validates the provider's rows.
3. Add the entry model and Parquet schema in the processor.

## Processing model

Each ingestion run is a full-history snapshot, from the symbol's
`backfillStartDate` up to the previous day. Each job rebuilds the Parquet file
from the latest completed run only. Rebuilds don't depend on earlier state, so
retrying or repeating a job is always safe.

Job lifecycle:

```txt
queued ──claim──> processing ──container 2xx──> completed
   ^                  ├──container error──────> failed
   └──container unreachable (message retried)──┘
                      └──stuck > 1h (cron)───> failed
```

- **Creating jobs.** The cron queues a job for each symbol whose latest
  completed run has no job yet, unless the symbol already has an active job.
  A unique index enforces one active job per symbol.
- **Failures.** A failed job is not retried for the same run. The next download
  creates a new run and a new job.
- **Delivery.** The cron resends every queued job each day, so a lost queue
  message only delays processing. The consumer processes one message at a
  time (`max_concurrency: 1`).
- **Container calls.** The consumer claims the job, POSTs the manifest to the
  container and waits. A `2xx` with `outputEtag` completes the job. An error
  response fails the job with the container's message. A network failure
  returns the job to `queued` and retries the message.

## Management API

All routes need `Authorization: Bearer <MANAGEMENT_API_TOKEN>`. See the
[README](../README.md) for examples.

## Not implemented yet

1. **Scheduled ingestion.** The cron should download a full snapshot for every
   enabled symbol before creating jobs. `ingestMarketData` exists but nothing
   calls it yet. Use the cron's `scheduledTime` for the end date, add a
   uniqueness guard per symbol and day, and bound concurrency.
2. **Manual refresh.** `POST /symbols/:dataset/:symbol/refresh`: run one
   ingestion now and queue its job, so an app can add a symbol and get data
   without waiting for the cron.
3. **Inspection.** A management endpoint showing each symbol's latest run, job
   status and error.
4. **Raw retention.** Delete raw objects older than N days, except the latest
   completed run per symbol.
5. **Second dataset** (FRED rates), as described above.

Deliberately left out: delta/merge processing, multiple providers for the same
`(dataset, symbol)`, and leases with fencing. Add them only if full rebuilds
become too slow or expensive.
