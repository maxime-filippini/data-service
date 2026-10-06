# Data service

Architecture and the Python-processor handoff are documented in
[MARKET_DATA_ARCHITECTURE.md](docs/MARKET_DATA_ARCHITECTURE.md).

Install dependencies and start the Worker locally:

```sh
pnpm install
pnpm dev
```

Apply the D1 control-plane schema before starting the Worker for the first
time:

```sh
pnpm db:migrate:local
```

The remote database is named `data-service-market-data`. Apply migrations to
it explicitly when deploying a schema change:

```sh
pnpm db:migrate:remote
```

## Market-data flow

The current HTTP cache remains available while ingestion moves to a run-based
model:

1. An ingestion run fetches one symbol and date range.
2. The validated response is stored as one immutable R2 object under its run
   ID.
3. D1 records the run and the raw object's key, ETag, observed range, and row
   count.
4. A processing job freezes the exact runs the Python processor must
   merge or use for a rebuild.
5. The eventual canonical object has one stable key per symbol:
   `dataset=prices_eod/symbol=<symbol>/data.parquet`.

`raw-market-data` stores immutable validated provider responses, while
`processed-market-data` stores the replaceable canonical Parquet dataset for
each symbol. The Worker binds them separately as `MARKET_DATA_BUCKET` and
`PROCESSED_MARKET_DATA_BUCKET`, respectively.

Only one processing job may be active per symbol. New ingestion runs that
arrive during processing remain available for the following job.

## Processing-job API

The Python processor uses a bearer token to access the following API under
`/processing-jobs`:

- `POST /` freezes eligible runs into a job. Its JSON body is
  `{ symbol, mode, transformVersion }`, where `mode` is `merge` or `rebuild`.
  `rebuild` selects only the latest completed snapshot by ingestion creation
  time, with run ID as a deterministic tie breaker. Each snapshot must contain
  the symbol's full history. `merge` selects all completed runs not yet applied.
- `GET /:jobId` returns the frozen raw-object selection and canonical target.
- `POST /:jobId/claim` atomically moves a queued job to `processing`.
- `POST /:jobId/complete` records `{ outputEtag, completeThrough? }` after
  the canonical Parquet object has been written.
- `POST /:jobId/fail` records `{ message }` and releases the symbol lock.

Set the token before deploying this API:

```sh
pnpm exec wrangler secret put PROCESSING_API_TOKEN
```

The processor must send `Authorization: Bearer <token>`. There is
intentionally no "next job" endpoint: the queue delivers a specific job ID
to the processor.

## Scheduled processing

The Worker runs daily at **02:00 UTC** (`0 2 * * *`). It creates `rebuild` jobs
with transform version `v1` for symbols whose latest completed snapshot has
not been applied, then publishes queued job IDs to `market-data-processing`. This also
delivers manually created jobs on the next schedule. Scheduling processes
existing ingestion runs; it does not fetch new provider data.

D1 remains the source of queued work. If queue publication fails, the next
schedule republishes it. At-least-once delivery is safe for completed jobs:
the consumer checks state before execution and the processor atomically claims
the job. A single consumer and container instance execute one job at a time.
The container listens on port 8080 and stays awake during execution, then
sleeps after five minutes of inactivity.

Delivery failures retry three times with a five-minute delay, then move to
`market-data-processing-dlq`. Inspect that queue and Worker logs for failed
deliveries. A claimed job is never automatically reclaimed: interrupted
processing requires reconciliation. Terminal failed jobs are acknowledged
and logged; symbols with failed, unapplied inputs are excluded from automatic
job creation. Inspect the canonical R2 object and D1 ETag before submitting a
manual merge or rebuild. A successful manual job applying those inputs, or a
later successful rebuild, allows scheduling to resume. Rebuilds overwrite
the canonical object.

### Raw snapshot retention policy

Daily full-history snapshots should have a 30-day retention window. Retain
the latest successful snapshot and any snapshot referenced by a queued or
processing job until a replacement is available or the job is reconciled.
The canonical Parquet object is kept independently of this raw retention.

This retention policy is not yet enforced. A bucket-wide age-only lifecycle
rule cannot protect those exceptions, so do not enable blanket expiration
until cleanup coordinates with D1 job state. Cleanup must also mark deleted
raw inputs unavailable so manual merge jobs cannot select them. Gzip storage
is a separate optimization requiring support in both the raw writer and
Python reader; existing raw envelopes remain uncompressed for now.

### Container deployment setup

Keep the processor repository checked out as `../data-service-processor`.
Wrangler builds its Dockerfile with that directory as the build context; CI
must also check out that repository beside this one at the intended revision.
Docker must be running for container builds, which target `linux/amd64`.

Create both queues before the first deployment:

```sh
pnpm exec wrangler queues create market-data-processing
pnpm exec wrangler queues create market-data-processing-dlq
```

Configure these additional Worker secrets (Wrangler passes them into the
container at runtime):

```sh
pnpm exec wrangler secret put PROCESSOR_API_TOKEN
pnpm exec wrangler secret put PROCESSING_API_URL
pnpm exec wrangler secret put R2_ENDPOINT_URL
pnpm exec wrangler secret put R2_ACCESS_KEY_ID
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
```

`PROCESSING_API_URL` must be the deployed Worker base URL reachable by the
container, including any prefix before `/processing-jobs`. The container uses
the Worker's existing `PROCESSING_API_TOKEN` for callbacks. Use a separate
`PROCESSOR_API_TOKEN` to authenticate execution. R2 credentials need read access
to `raw-market-data` and read/write access to `processed-market-data`.
No credentials are baked into the image.

Deploy with `pnpm deploy` after applying D1 migrations and configuring secrets.
For local development, add these values to ignored `.dev.vars`, use a Worker
URL reachable from Docker, and run `pnpm dev --test-scheduled`. Trigger the
local schedule through `/cdn-cgi/handler/scheduled`. Local queue simulation
does not validate the processor's remote R2 access or callback routing.

## Deployment

```txt
pnpm deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```sh
pnpm cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiating `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```


## To do

Things that have been postponed but will have to be tackled eventually:

- [ ] Market data cache writes should be done outside of the GET request
- [ ] Trigger run-based ingestion from a schedule rather than an HTTP read
- [ ] Replace the temporary validated-response envelope with the provider's
      exact response bytes when provider adapters expose them
