# Data service

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
4. A processing job freezes the exact runs a future Python processor must
   merge or use for a rebuild.
5. The eventual canonical object has one stable key per symbol:
   `dataset=prices_eod/symbol=<symbol>/data.parquet`.

`raw-market-data` stores immutable validated provider responses, while
`processed-market-data` stores the replaceable canonical Parquet dataset for
each symbol. The Worker binds them separately as `MARKET_DATA_BUCKET` and
`PROCESSED_MARKET_DATA_BUCKET`, respectively.

Only one processing job may be active per symbol. New ingestion runs that
arrive during processing remain pending for the following merge job.

## Processing-job API

The Python processor uses a bearer token to access the following API under
`/processing-jobs`:

- `POST /` freezes eligible runs into a job. Its JSON body is
  `{ symbol, mode, transformVersion }`, where `mode` is `merge` or `rebuild`.
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
intentionally no "next job" endpoint yet: a future queue will deliver a
specific job ID to the processor.

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
- [ ] Publish processing-job IDs to the external Python processor
- [ ] Replace the temporary validated-response envelope with the provider's
      exact response bytes when provider adapters expose them
