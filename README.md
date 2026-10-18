# Data service

Personal market-data service on Cloudflare Workers. It downloads data for a
universe of symbols, builds one Parquet file per symbol in R2, and exposes a
small API so other apps can manage the universe. Apps read the Parquet files
from R2 directly:

```txt
processed-market-data/dataset=prices_eod/symbol=AAPL.US/data.parquet
```

How it works: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The Python
processor lives in
[data-service-processor](https://github.com/maxime-filippini/data-service-processor),
which must be checked out next to this repo (`../data-service-processor`).

## Setup

```sh
pnpm install
cp .dev.vars.example .dev.vars   # then fill in real values
pnpm db:migrate:local
pnpm dev
```

Remote resources: the `data-service-market-data` D1 database, the
`raw-market-data` and `processed-market-data` buckets, and the
`market-data-ingestion`, `market-data-ingestion-dlq`, `market-data-processing`
and `market-data-processing-dlq` queues. Secrets:

```sh
pnpm exec wrangler secret put EODHD_API_TOKEN
pnpm exec wrangler secret put MANAGEMENT_API_TOKEN
pnpm exec wrangler secret put R2_ENDPOINT_URL        # https://<account-id>.r2.cloudflarestorage.com
pnpm exec wrangler secret put R2_ACCESS_KEY_ID       # used by the processor container
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
pnpm db:migrate:remote
pnpm run deploy                                      # needs Docker to build the container
```

## Managing symbols

The API is served at `https://data-service.maxime-filippini.workers.dev`
(`$URL` below). All routes need `Authorization: Bearer $MANAGEMENT_API_TOKEN`.

Register or update a symbol. Re-registering a disabled symbol enables it:

```sh
curl -X POST "$URL/symbols" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dataset":"prices_eod","symbol":"AAPL.US","provider":"eodhd","backfillStartDate":"2016-01-01"}'
```

`enabled` is optional and defaults to `true`. Returns `201` when the symbol is
new and `200` on update. Symbols are uppercase with an optional exchange suffix
(`AAPL`, `AAPL.US`, `BRK-B.US`). The provider must be able to supply the
dataset.

List symbols, optionally filtered:

```sh
curl "$URL/symbols?dataset=prices_eod&enabled=true" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Stop scheduled downloads for a symbol. Its history and Parquet file are kept:

```sh
curl -X POST "$URL/symbols/prices_eod/AAPL.US/disable" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Errors: `400` invalid input, `401` bad token, `404` unknown symbol, `500` database error.

## Running ingestions

Download the full history of registered symbols now and rebuild their Parquet
files:

```sh
curl -X POST "$URL/ingestions" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"entries":[{"dataset":"prices_eod","symbol":"AAPL.US"},{"dataset":"prices_eod","symbol":"MSFT.US"}]}'
```

Returns `202` with the queued entries and the date range each will download
(from the symbol's `backfillStartDate` to the previous UTC day). Up to 500
entries per request; duplicates are ignored. Disabled symbols can still be
ingested manually. If any entry is not registered, or its history starts after
the previous day, the request returns `400` with the `rejected` entries and
queues nothing.

Each entry downloads in the background, then its Parquet rebuild is queued
straight away. A symbol that already has a download in progress is skipped.

## Checks

```sh
pnpm test
pnpm typecheck
```
