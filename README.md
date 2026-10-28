# Data service

Personal market-data service on Cloudflare Workers. It downloads data for a
universe of symbols, builds one Parquet file per symbol in R2, and exposes a
small API so other apps can manage the universe. It also runs calculations,
such as ex-ante volatility, over portfolios on a schedule or on demand, and
stores their results next to the data. Apps read the Parquet files from R2
directly:

```txt
processed-market-data/dataset=prices_eod/symbol=AAPL.US/data.parquet
processed-market-data/calculation=<calculation-id>/data.parquet
```

How it works, with diagrams: the docs site at `$URL/docs/` (source in
[`docs/`](docs/), `pnpm docs:dev` to edit).

| Path | What |
| --- | --- |
| `src/` | The Worker (TypeScript) |
| `containers/processor/` | The Python processor container ([README](containers/processor/README.md)) |
| `containers/engine/` | The Python calculation engine container ([README](containers/engine/README.md)) |
| `dashboard/` | The Svelte dashboard, served by the Worker at `/dashboard/` |
| `docs/` | The docs site (Astro Starlight), served by the Worker at `/docs/` |
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
pnpm exec wrangler secret put R2_ACCESS_KEY_ID       # used by the processor and engine containers
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

Each deploy builds the processor and engine images from `containers/processor`
and `containers/engine` and ships them with the Worker, so all three always come
from the same commit. CI also runs the engine's tests and lint. Wrangler only rolls
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
`pnpm dev` can't run the full pipeline: the containers read real R2 while the
local Worker writes to simulated buckets. To try the dashboard without them,
run `pnpm exec wrangler dev --enable-containers=false`; pages that need the
engine (calculation types, saving params, runs) show its error.

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

## Portfolios

A portfolio is a name and a series of dated holdings snapshots, which
calculations run over. Every symbol must be tracked in `prices_eod` (disabled
symbols count), weights are any non-zero numbers, and a portfolio has at most
one snapshot per date. Snapshots can't be edited: delete one and add it again.
See [Portfolios](docs/calculation-engine.md#portfolios).

```sh
# Create one, optionally with its first snapshot
curl -X POST "$URL/portfolios" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Core","snapshot":{"holdingsDate":"2026-09-30","holdings":[{"symbol":"AAPL.US","weight":0.6},{"symbol":"MSFT.US","weight":0.4}]}}'

# List them; get one with its snapshots
curl "$URL/portfolios" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/portfolios/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

# Rename or delete one
curl -X PATCH "$URL/portfolios/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"Core equity"}'
curl -X DELETE "$URL/portfolios/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

# Add a snapshot, or delete the one for a date
curl -X POST "$URL/portfolios/$ID/snapshots" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"holdingsDate":"2026-10-15","holdings":[{"symbol":"AAPL.US","weight":1}]}'
curl -X DELETE "$URL/portfolios/$ID/snapshots/2026-10-15" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Untracked symbols return `400` with their list in `symbols`; a second snapshot
for the same date returns `409`. Deleting a portfolio a calculation uses
returns `409` with those calculations in `calculations`.

## Calculations

A calculation is a saved calculation type with its params, the portfolios it
runs over, a cron expression (UTC) and an enabled flag. Its results go to
`calculation=<id>/data.parquet` in the processed bucket. See
[the calculation engine spec](docs/calculation-engine.md), and
[the engine README](containers/engine/README.md) to add a type.

```sh
# The engine's types, with each one's params JSON Schema and output columns
curl "$URL/calculation-types" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

# Create one. The engine checks the params and fills in defaults.
curl -X POST "$URL/calculations" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Core vol","type":"ex_ante_vol","params":{"window":126},"portfolioIds":["'"$PORTFOLIO_ID"'"],"cron":"0 8 * * 1-5"}'

# List them (with each one's latest run); get one
curl "$URL/calculations" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/calculations/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

# Change the name, params, portfolios, cron or enabled flag (not the type); delete one
curl -X PATCH "$URL/calculations/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
curl -X DELETE "$URL/calculations/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

# Run now, optionally as of a past date (default: the previous UTC day)
curl -X POST "$URL/calculations/$ID/runs" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"asOf":"2026-10-16"}'

# Its runs, newest first (limit up to 100, default 20); one run
curl "$URL/calculations/$ID/runs?limit=10" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/calculations/$ID/runs/$RUN_ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

- Invalid params return `422` with the engine's errors in `detail`. A type
  that takes a portfolio needs at least one; other types take none.
- Run now returns `202 {"runId", "status"}` straight away. `status` is
  `skipped` if the calculation already has a run going.
- A run ends `completed`, `partial` (some portfolios failed, with each one's
  error in `portfolios`) or `failed`.
- The hourly cron starts a run when a calculation's cron fires, as of the
  previous UTC day, so schedule calculations a few hours after the download
  hour. The minute field has no effect. Deleting a calculation deletes its
  runs; its results stay in R2.

### Ad hoc calculations

`POST /calculate` runs a type and returns the result without saving anything,
with a timeout of about 60 seconds. `portfolio` is a saved portfolio
(`{"portfolioId": …}`, using its snapshots up to `asOf`) or plain holdings
held at all times. `asOf` defaults to the previous UTC day.

```sh
curl -X POST "$URL/calculate" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"ex_ante_vol","params":{},"portfolio":{"holdings":[{"symbol":"AAPL.US","weight":1}]}}'
```

It returns `{"rows": [...]}`, or an Arrow IPC stream with
`Accept: application/vnd.apache.arrow.stream`. Unknown types return `404`;
invalid params and expected failures, such as missing prices, return `422`;
other failures return `500`.

## Dashboard

`$URL/dashboard/` shows ingestion runs (with their Parquet rebuilds), the
tracked symbols with their latest activity, and an explorer for each symbol's
Parquet data and each calculation's results (sort, filter by date, download).
On the Symbols page you can also add symbols (several at once, with the same
settings) and edit them, put them on or off the daily schedule, download them
now, and change, pause or run the schedule.

The Portfolios page creates, renames and deletes portfolios, and adds or
deletes their snapshots (type or paste symbol and weight rows, or start from
the latest snapshot). The Calculations page creates and edits calculations,
with a JSON editor for params and the type's params as help, pauses or enables
them, runs them now for any as-of date, and shows their runs with each
portfolio's outcome.

Sign-in uses [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
with GitHub. Access sits in front of `/dashboard` and `/docs` only, so the API
keeps using the management token. The Worker also checks the token Access adds
to each request (`Cf-Access-Jwt-Assertion`) and the user's email, so the
dashboard and docs stay closed if the Access app is removed or its policy is loosened. If any of
the settings below is missing, the dashboard returns `503`.

One-time setup, per environment (prod and dev have separate hostnames):

1. **GitHub login.** In Zero Trust, go to Settings > Authentication and add
   GitHub as a login method. This needs a GitHub OAuth app whose callback URL
   is `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
2. **Access application.** Under Access controls > Applications, add a
   self-hosted application:
   - Domains: `data-service.maxime-filippini.workers.dev` with path
     `dashboard`, and the same hostname again with path `docs` (dev:
     `data-service-dev.maxime-filippini.workers.dev`). Both paths must be in
     this one application, since the Worker checks a single AUD.
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
pnpm docs:build
pnpm processor:test     # needs uv
pnpm processor:lint
pnpm engine:test        # needs uv
pnpm engine:lint
```
