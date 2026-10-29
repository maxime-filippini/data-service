# Architecture

A personal market-data service. It downloads data for a universe of symbols on
a schedule, turns each symbol's history into one Parquet file in R2, and lets
other apps manage the universe. On top of that data it runs calculations over
portfolios, such as ex-ante volatility, and stores their results next to the
datasets. Apps read the Parquet files from R2 directly; the management API
never serves market data. Only the app does, so its users can browse the
files.

```txt
hourly cron → Workflow (daily run) ─┐
POST /ingestions ───────────────────┴→ ingestion Queue → Worker consumer → provider API
   → raw R2 object + ingestion run (D1)
   → processing job (D1) → Queue → Worker consumer → Python container
   → canonical Parquet in R2 → job completed (D1)

hourly cron (calculation cron due) ─┐
POST /calculations/:id/runs ────────┴→ calculation run (D1) → Workflow → engine container
   → per portfolio: type.run(params, ctx) → calculation Parquet in R2
   → run completed / partial / failed (D1)

POST /calculate (ad hoc) → Worker → engine container → result in the response
```

Glossary: [CONTEXT.md](../CONTEXT.md).

## Parts

| Part | Role |
| --- | --- |
| Worker | Management API, hourly cron, ingestion consumer (provider downloads, raw storage), all D1 state, processing consumer that drives the processor container, and the calculation API that drives the engine container. |
| `ScheduledDownloadWorkflow` | One Workflow instance per run of the daily schedule. Queues a download for every enabled symbol and records the outcome. |
| `CalculationRunWorkflow` | One Workflow instance per calculation run. Calls the engine and records the outcome. |
| App ([`app/`](../app)) | SvelteKit app: a home page summing up both pipelines, and pages for runs, symbols, the schedule, portfolios, calculations and the Parquet data. Runs inside the Worker behind Cloudflare Access. It can edit the registry, the schedule, portfolios and calculations, start downloads and run calculations. |
| D1 | Universe (`tracked_symbols`), `download_schedule`, `schedule_runs`, `ingestion_runs`, `processing_jobs`; `portfolios`, `portfolio_snapshots`, `portfolio_holdings`; `calculations`, `calculation_portfolios`, `calculation_runs`. No market data or results. |
| `raw-market-data` (R2) | Immutable validated provider responses, one per run. |
| Processor container ([`containers/processor`](../containers/processor)) | Reads one raw object, writes one Parquet object, returns its ETag. No D1 access, no callbacks. |
| Engine container ([`containers/engine`](../containers/engine)) | Holds every calculation type. Validates params, runs calculations over the canonical Parquet files and writes their results. Reads and writes the processed bucket only; no D1 access. |
| `processed-market-data` (R2) | One Parquet object per `(dataset, symbol)`, and one per calculation. This is what apps read. |

## Storage layout

```txt
raw-market-data/dataset=<dataset>/symbol=<symbol>/run=<run-id>.json
processed-market-data/dataset=<dataset>/symbol=<symbol>/data.parquet
processed-market-data/calculation=<calculation-id>/data.parquet
```

A calculation's file holds its type's output columns plus `as_of` and
`portfolio_id`, one set of rows per as-of date.

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

## Daily schedule

One schedule downloads every enabled symbol once a day. `download_schedule`
holds its UTC hour and a paused flag (it starts paused). Both the management
API (`/schedule`) and the app can change them.

- **Trigger.** The cron fires at the top of every hour. Once the schedule's
  hour has passed and today has no scheduled run, it records the run in
  `schedule_runs` (`schedule-<date>`) and starts a Workflow instance with the
  same ID. A missed hour is caught up on the next tick. A partial unique index
  allows one scheduled run per UTC day; a duplicate Workflow ID is refused too.
- **Workflow.** Lists the enabled symbols whose history has started, sends
  them to the ingestion queue in batches of 100 (one step per batch), then
  records how many it queued. Downloads run up to the day before the run, as
  with manual ingestions. A failure is recorded on the run.
- **Manual runs.** "Run now" (`POST /schedule/runs`) starts the same Workflow
  as a `manual-<date>-<id>` run. It doesn't use up the day's scheduled run.
- **Failures.** If the Workflow can't start, the cron forgets the run and the
  next tick retries. A run still `running` after an hour is marked failed.

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

## Calculations

The full design is in [calculation-engine.md](calculation-engine.md); this is
how the parts fit together.

- **Portfolios.** `portfolios`, with dated holdings snapshots in
  `portfolio_snapshots` and `portfolio_holdings` (one row per symbol). A
  foreign key from holdings to `tracked_symbols` keeps a held symbol from
  being deleted. Snapshots are added or deleted, never edited.
- **Calculations.** `calculations` holds the type, params (JSON, as the engine
  returned them with defaults filled in), cron, enabled flag and the last cron
  slot it ran for; `calculation_portfolios` lists its portfolios in order. The
  Worker knows no calculation types: it asks the engine for the list
  (`GET /types`) and to validate params (`POST /types/:name/validate`).
- **Runs.** Starting a run records a `calculation_runs` row as `running` and
  starts a `CalculationRunWorkflow` instance with the run ID. A partial unique
  index allows one `running` run per calculation, so a run started meanwhile
  is recorded as `skipped`. The Workflow loads every portfolio's snapshots up
  to the as-of date and calls the engine's `POST /runs` in one step (2
  retries, 30-minute timeout; the engine replaces the as-of date's rows, so a
  retry is safe). A portfolio with no snapshot by then fails in the Worker
  without reaching the engine. The outcome (`completed`, `partial` or
  `failed`, with each portfolio's result) is saved on the run.
- **Why a Workflow.** A step has no wall-clock limit, while a queue consumer
  has 15 minutes, and engine runs can be long. One instance per run is also
  addressable by run ID, so the Worker can check that a run is still alive.
- **Stuck runs.** A run `running` for over 5 minutes is checked against its
  Workflow. If the Workflow has errored, been terminated, finished without
  recording, or never started, the run is marked failed so it doesn't block
  later runs. This happens on every hourly tick and before each new run.
- **Scheduling.** On each hourly tick, after the download trigger and the
  stuck-run check, each enabled calculation whose most recent cron slot is
  later than its `last_scheduled_slot` (and its creation) claims that slot
  with a conditional update and starts a run as of the previous UTC day. The
  minute field is ignored. A missed slot runs once on the next tick. Download
  scheduling and calculation scheduling fail independently.
- **Ad hoc.** `POST /calculate` sends a type, params and a portfolio straight
  to the engine's `POST /calculate` and returns its rows (JSON or Arrow),
  with a 60-second timeout. Nothing is saved.
- **Engine instances.** One container instance (`getByName("engine")`), like
  the processor.

## Management API

Served under `/api`. All routes need `Authorization: Bearer
<MANAGEMENT_API_TOKEN>`; Cloudflare Access lets `/api` through. See the
[README](../README.md) for examples.

## App

A SvelteKit app in `app/` (adapter-cloudflare). Routing lives in
`src/routes/index.ts`: `/api/*` is the management API, `/app-api/*` the app's
JSON API, `/docs/*` the docs, and everything else goes to SvelteKit's handler,
which `src/index.ts` imports from the app's build
(`app/.svelte-kit/cloudflare/_worker.js`). The adapter reads
`app/wrangler.adapter.jsonc`, not the real config, because it deletes and
rewrites the `main` it's given. The Worker runs before the assets
(`run_worker_first`), so every request but `/api`, static files included,
needs a Cloudflare Access user whose email is in `DASHBOARD_ALLOWED_EMAILS`.
The Worker passes the user's email to SvelteKit in `X-Access-Email`, which it
always sets itself. The management token is never sent to the browser.

- **Pages** (`/`, `/runs`, `/symbols`, `/portfolios[/:id]`,
  `/calculations[/:id]`, `/explore`) load their data in `+page.server.ts` from
  `src/pages` (reads only). The app typechecks against `src/pages/app.ts`, a
  declarations-only facade, because the Worker's modules need the Workers
  runtime types, which clash with the DOM's. `src/pages/index.ts` checks that
  it matches the facade.
- **The JSON API** (`/app-api`) serves changes, "load more" and refreshes from
  the browser:

  - **Reads:** `/me`, `/runs`, `/symbols` (status views from `PipelineStatus`),
    `/datasets/:dataset/:symbol` and `/calculations/:id/results` (Parquet
    files) and `/options` (datasets and their providers, for the registry form).
  - **Changes:** `/registry`, `/ingestions`, `/schedule`, `/portfolios`,
    `/calculation-types`, `/calculate` and `/calculations` mount the same route
    modules as the management API's `/symbols`, `/ingestions`, `/schedule`,
    `/portfolios`, `/calculation-types`, `/calculate` and `/calculations`, with
    Access in place of the token. Browsers send the Access cookie on
    cross-site requests too, so every non-GET request must come from the
    app's own origin (`Origin` or `Sec-Fetch-Site`), or it gets `403`.

The portfolio and calculation pages edit portfolios, snapshots and
calculations through the routes above. Params are edited as JSON, with the
type's params schema from the engine shown as help; the engine checks them on
save. Portfolio and calculation types shared with the Worker live in
import-free `views.ts` files, like the status and schedule views.

The dataset explorer fetches a symbol's whole canonical Parquet file from
`/app-api/datasets/:dataset/:symbol`, or a calculation's results from
`/app-api/calculations/:id/results`. The Worker streams it from the
processed bucket with its ETag and `Cache-Control: private, no-cache`, so the
browser only downloads it again after it changes. The browser decodes it with
[hyparquet](https://github.com/hyparam/hyparquet) (zstd through `fzstd`, both
plain JS because the CSP blocks WASM) and shows it in a TanStack Table with
sorting, a date range (on `as_of` for calculation results) and pages. Columns
come from the file's schema, so a new dataset or calculation type needs no
dashboard changes. Files are small (one symbol's daily
history), so reading them whole is fine; for much larger files, switch to
range requests.

## Not implemented yet

1. **Inspection.** A management endpoint showing each symbol's latest run, job
   status and error.
2. **Raw retention.** Delete raw objects older than N days, except the latest
   completed run per symbol.
3. **Second dataset** (FRED rates), as described above.
4. **Deleting tracked symbols.** The registry has no delete route. Whoever adds
   it maps the foreign-key failure for a symbol a snapshot holds to `409`
   with the portfolios holding it (`portfolio_holdings_by_symbol` finds them).

Deliberately left out: delta/merge processing, multiple providers for the same
`(dataset, symbol)`, and leases with fencing. Add them only if full rebuilds
become too slow or expensive.
