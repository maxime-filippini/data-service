# Architecture

A personal market-data service. It downloads data for a universe of symbols on
a schedule, turns each symbol's history into one Parquet file in R2, and lets
other apps manage the universe. Apps read the Parquet files from R2 directly;
the management API never serves market data. Only the dashboard does, so its
users can browse the files.

```txt
POST /ingestions → ingestion Queue → Worker consumer → provider API
   → raw R2 object + ingestion run (D1)
   → processing job (D1) → Queue → Worker consumer → Python container
   → canonical Parquet in R2 → job completed (D1)
```

Glossary: [CONTEXT.md](../CONTEXT.md).

## Parts

| Part | Role |
| --- | --- |
| Worker | Management API, ingestion consumer (provider downloads, raw storage), all D1 state, processing consumer that drives the container. |
| Dashboard ([`dashboard/`](../dashboard)) | Read-only Svelte app for runs, symbols and the Parquet data, served by the Worker behind Cloudflare Access. |
| D1 | Universe (`tracked_symbols`), `ingestion_runs`, `processing_jobs`. No market data. |
| `raw-market-data` (R2) | Immutable validated provider responses, one per run. |
| Python container ([`containers/processor`](../containers/processor)) | Reads one raw object, writes one Parquet object, returns its ETag. No D1 access, no callbacks. |
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

## Ingestion model

`POST /ingestions` checks that every entry is registered, then sends one
message per symbol to the `market-data-ingestion` queue. The message fixes the
snapshot's end date (the previous UTC day), so a retry downloads the same
range.

The consumer looks up the symbol's provider and start date, downloads, stores
the raw object and completes the run. It then creates the processing job for
that run and sends it to the processing queue straight away. If the symbol
already has an active job, the new run waits for the daily cron.

- **One download at a time per symbol.** Starting a run is skipped if the
  symbol already has a `fetching` run; a partial unique index backs this up.
  A `fetching` run older than 30 minutes is assumed dead and failed first.
- **Retries.** Each delivery gets a fresh run ID. Network, storage and
  database errors retry the message (3 times, then the DLQ). Bad configuration,
  invalid provider data and unregistered symbols do not.

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

- **Creating jobs.** The ingestion consumer queues a job right after each
  run. As a fallback, the cron queues a job for each symbol whose latest
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

## Dashboard

A Svelte app in `dashboard/`, built into the Worker's static assets and served
at `/dashboard/`, with a read-only API at `/dashboard/api/*` (`/me`, `/runs`,
`/symbols`, `/datasets/:dataset/:symbol`). The Worker runs before the assets (`run_worker_first`), so every
dashboard request, including its files, needs a Cloudflare Access user whose
email is in `DASHBOARD_ALLOWED_EMAILS`. The API reads D1 through the
`PipelineStatus` service; it never changes state. The management token is never
sent to the browser.

The dataset explorer fetches a symbol's whole canonical Parquet file from
`/dashboard/api/datasets/:dataset/:symbol`. The Worker streams it from the
processed bucket with its ETag and `Cache-Control: private, no-cache`, so the
browser only downloads it again after a rebuild. The browser decodes it with
[hyparquet](https://github.com/hyparam/hyparquet) (zstd through `fzstd`, both
plain JS because the CSP blocks WASM) and shows it in a TanStack Table with
sorting, a date range and pages. Columns come from the file's schema, so a new
dataset needs no dashboard changes. Files are small (one symbol's daily
history), so reading them whole is fine; for much larger files, switch to
range requests.

## Not implemented yet

1. **Scheduled ingestion.** The cron should call `requestIngestions` for every
   enabled symbol, using its `scheduledTime` for the end date. Consider a guard
   against downloading the same symbol and end date twice.
2. **Inspection.** A management endpoint showing each symbol's latest run, job
   status and error.
3. **Raw retention.** Delete raw objects older than N days, except the latest
   completed run per symbol.
4. **Second dataset** (FRED rates), as described above.

Deliberately left out: delta/merge processing, multiple providers for the same
`(dataset, symbol)`, and leases with fencing. Add them only if full rebuilds
become too slow or expensive.
