# Data service

Personal market-data service on Cloudflare Workers. It downloads data for a
universe of symbols, builds one Parquet file per symbol in R2, and exposes a
small API so other apps can manage the universe. Apps read the Parquet files
from R2 directly:

```txt
processed-market-data/dataset=prices_eod/symbol=AAPL.US/data.parquet
```

How it works: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Path | What |
| --- | --- |
| `src/` | The Worker (TypeScript) |
| `containers/processor/` | The Python processor container ([README](containers/processor/README.md)) |
| `containers/engine/` | The Python calculation engine container ([README](containers/engine/README.md)) |
| `dashboard/` | The Svelte dashboard, served by the Worker at `/dashboard/` |
| `migrations/` | D1 migrations |

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

The dashboard needs three more secrets; see [Dashboard](#dashboard).

## Deploying

GitHub Actions (`.github/workflows/deploy.yml`) checks the Worker and the
processor on every push and pull request, then applies D1 migrations and
deploys:

| Branch | Target |
| --- | --- |
| `main` | production (`data-service`) |
| `develop`, `feat/*`, `fix/*` | dev environment (`data-service-dev`) |

Each deploy builds the processor image from `containers/processor` and ships it
with the Worker, so both always come from the same commit. Wrangler only rolls
out containers when the image changes.

So the flow is: push a `feat/*` or `fix/*` branch and test it on dev, merge it
into `develop`, then merge `develop` into `main` to release. All branches share
the dev environment, so the latest push wins. A migration applied to dev from a
branch stays applied even if the branch is abandoned. To deploy any other
branch to dev, run the workflow manually from the Actions tab.

The workflow needs a `CLOUDFLARE_API_TOKEN` repository secret. To deploy by
hand instead, run `pnpm db:migrate:remote && pnpm run deploy` with Docker
running.

## Dev environment

A separate deployment for end-to-end testing of any branch:
`https://data-service-dev.maxime-filippini.workers.dev`. It has its own
database (`data-service-market-data-dev`), buckets (`raw-market-data-dev`,
`processed-market-data-dev`), queues (`*-dev`), Workflow and secrets, and no
cron: use "Run now" or `POST /schedule/runs` to try the schedule there.

CI deploys it (see [Deploying](#deploying)). To deploy by hand, with Docker
running:

```sh
pnpm db:migrate:dev
pnpm deploy:dev
```

One-time secrets (use an R2 API token scoped to the two dev buckets):

```sh
for name in EODHD_API_TOKEN MANAGEMENT_API_TOKEN R2_ENDPOINT_URL R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY \
  ACCESS_TEAM_DOMAIN ACCESS_AUD DASHBOARD_ALLOWED_EMAILS; do
  pnpm exec wrangler secret put "$name" --env dev
done
```

Workflow: develop and run unit tests with `pnpm dev`, then push the branch and
test end to end on dev.
`pnpm dev` can't run the full pipeline: the container reads real R2 while the
local Worker writes to simulated buckets.

## Managing symbols

The API is served at `https://data-service.maxime-filippini.workers.dev`
(`$URL` below). All routes need `Authorization: Bearer $MANAGEMENT_API_TOKEN`,
except the [dashboard](#dashboard).

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

Take a symbol off the daily schedule, or put it back on. Its history and
Parquet file are kept either way:

```sh
curl -X POST "$URL/symbols/prices_eod/AAPL.US/disable" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X POST "$URL/symbols/prices_eod/AAPL.US/enable" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
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

## Daily schedule

Every enabled symbol is downloaded once a day, after the schedule's UTC hour.
The schedule starts **paused**; resume it to start daily downloads. See
[Daily schedule](docs/ARCHITECTURE.md#daily-schedule) for how runs work.

```sh
# Show it, with the next run time
curl "$URL/schedule" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

# Run after 06:00 UTC and resume it (both fields are optional)
curl -X PATCH "$URL/schedule" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"hourUtc":6,"paused":false}'

# Recent runs, newest first (limit up to 100, default 20)
curl "$URL/schedule/runs?limit=5" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

# Run it now, on top of the daily run
curl -X POST "$URL/schedule/runs" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

## Dashboard

`$URL/dashboard/` shows ingestion runs (with their Parquet rebuilds), the
tracked symbols with their latest activity, and an explorer for each symbol's
Parquet data (sort, filter by date, download). On the Symbols page you can also
add symbols (several at once, with the same settings) and edit them, put them
on or off the daily schedule, download them now, and change, pause or run the
schedule.

Sign-in uses [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
with GitHub. Access sits in front of `/dashboard` only, so the API keeps using
the management token. The Worker also checks the token Access adds to each
request (`Cf-Access-Jwt-Assertion`) and the user's email, so the dashboard
stays closed if the Access app is removed or its policy is loosened. If any of
the settings below is missing, the dashboard returns `503`.

One-time setup, per environment (prod and dev have separate hostnames):

1. **GitHub login.** In Zero Trust, go to Settings > Authentication and add
   GitHub as a login method. This needs a GitHub OAuth app whose callback URL
   is `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
2. **Access application.** Under Access controls > Applications, add a
   self-hosted application:
   - Domain: `data-service.maxime-filippini.workers.dev`, path `dashboard`
     (dev: `data-service-dev.maxime-filippini.workers.dev`).
   - Login methods: GitHub only, with instant auth.
   - Policy: Allow, include Emails = your GitHub account's primary email.
3. **Secrets.** Copy the application's AUD tag from its settings, then:

   ```sh
   pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN         # https://<team>.cloudflareaccess.com
   pnpm exec wrangler secret put ACCESS_AUD                 # the application's AUD tag
   pnpm exec wrangler secret put DASHBOARD_ALLOWED_EMAILS   # your email; comma-separated for more
   ```

   Add `--env dev` for the dev environment, with the dev application's AUD.

Locally, `pnpm dev` builds the dashboard and serves it at
`http://localhost:8787/dashboard/`. Set `DASHBOARD_LOCAL_BYPASS=true` in
`.dev.vars` to skip the Access check; it only works for requests to
localhost. For hot reload while editing the dashboard, run `pnpm dev` and
`pnpm dashboard:dev` together and open `http://localhost:5173/dashboard/`.

## Checks

```sh
pnpm test
pnpm typecheck
pnpm dashboard:check
pnpm processor:test     # needs uv
pnpm processor:lint
pnpm engine:test        # needs uv
pnpm engine:lint
```
