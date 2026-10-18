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
[data-service-processor](https://github.com/maxime-filippini/data-service-processor).
Its CI publishes the container image that `wrangler.jsonc` pins.

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
```

## Deploying

GitHub Actions (`.github/workflows/deploy.yml`) runs `pnpm typecheck` and
`pnpm test` on every push and pull request, then applies D1 migrations and
deploys:

| Branch | Target |
| --- | --- |
| `main` | production (`data-service`) |
| `develop`, `feat/*`, `fix/*` | dev environment (`data-service-dev`) |

So the flow is: push a `feat/*` or `fix/*` branch and test it on dev, merge it
into `develop`, then merge `develop` into `main` to release. All branches share
the dev environment, so the latest push wins. A migration applied to dev from a
branch stays applied even if the branch is abandoned. To deploy any other
branch to dev, run the workflow manually from the Actions tab.

The workflow needs a `CLOUDFLARE_API_TOKEN` repository secret.

### Processor image

`containers[].image` in `wrangler.jsonc` pins a processor image by commit SHA,
in both the top-level block and `env.dev`. The processor repo publishes
`data-service-processor:<sha>` on every push to any branch. To ship a processor
change, push it there, then put the new SHA in both blocks in a branch here.
To try a processor branch on dev, change only the `env.dev` block.

## Dev environment

A separate deployment for end-to-end testing of any branch:
`https://data-service-dev.maxime-filippini.workers.dev`. It has its own
database (`data-service-market-data-dev`), buckets (`raw-market-data-dev`,
`processed-market-data-dev`), queues (`*-dev`) and secrets, and no cron.

CI deploys it (see [Deploying](#deploying)). To deploy by hand:

```sh
pnpm db:migrate:dev
pnpm deploy:dev
```

One-time secrets (use an R2 API token scoped to the two dev buckets):

```sh
for name in EODHD_API_TOKEN MANAGEMENT_API_TOKEN R2_ENDPOINT_URL R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  pnpm exec wrangler secret put "$name" --env dev
done
```

Workflow: develop and run unit tests with `pnpm dev`, then push the branch and
test end to end on dev.
`pnpm dev` can't run the full pipeline: the container reads real R2 while the
local Worker writes to simulated buckets.

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
