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
`market-data-processing` and `market-data-processing-dlq` queues. Secrets:

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

All routes need `Authorization: Bearer $MANAGEMENT_API_TOKEN`.

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

## Checks

```sh
pnpm test
pnpm typecheck
```
