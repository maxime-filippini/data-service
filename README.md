# Data service

Personal market-data and portfolio workflow service on Cloudflare Workers. It
stores complete workflow specifications as data, executes ordered steps with
Effect inside Cloudflare Workflows, calls one uniform Python service for
normalization and numerical operations, and publishes Parquet datasets to R2 by
dataset name and subject:

```txt
processed-market-data/dataset=prices_eod/symbol=AAPL.US/data.parquet
processed-market-data/dataset=portfolio_volatility/portfolio=<portfolio-id>/data.parquet
```

Full documentation with diagrams is served at `$URL/docs/` (source in
[`docs/`](docs/), `pnpm docs:dev` to edit).

| Path                 | What                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| `src/`               | The Worker (TypeScript, Hono, Effect, Cloudflare Workflows)                 |
| `containers/engine/` | The single Python operation service ([README](containers/engine/README.md)) |
| `app/`               | The SvelteKit app, served by the Worker at `/`                              |
| `docs/`              | The docs site (Astro Starlight), served by the Worker at `/docs/`           |
| `migrations/`        | D1 migrations (`0001`–`0014`)                                               |
| `scripts/`           | Fixture runner, contract generator, migration and smoke scripts             |

## Finding your way around

Start with the [maintainer guide](docs/src/content/docs/maintaining.md): it maps
domain operations to files, explains Effect and Cloudflare durability in this
codebase, and documents how to add a Python-backed operation or an Effect-only
step. [CONTEXT.md](CONTEXT.md) is the domain glossary.

## End-to-end local scenario (no credentials)

Run the full asset and portfolio workflow path locally against fixture data
(requires [uv](https://docs.astral.sh/uv/)):

```sh
pnpm install
pnpm workflow:fixture
```

This starts the real Python service with `uv`, runs real D1 migrations on local
SQLite, creates assets, a daily download–normalize–publish workflow, a portfolio
with changing dated holdings, and a portfolio volatility workflow through the
management API, executes them through the real executor and Python HTTP
operations, and writes inspectable artifacts, published Parquet datasets, and
run records to `.local/workflow-fixture/`. Pass `--scheduled` to dispatch the
asset runs through the daily UTC scheduler.

## Local Worker and app

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in real values for local Worker dev
pnpm db:migrate:local
pnpm dev
```

`pnpm dev` serves the app at `http://localhost:8787/`, the management API at
`http://localhost:8787/api/`, and the docs at `http://localhost:8787/docs/`.
For hot reload while editing the app, run `pnpm dev` and `pnpm app:dev`
together (`http://localhost:5173/`).

## Management API

All `/api/*` routes require `Authorization: Bearer $MANAGEMENT_API_TOKEN`
(Cloudflare Access bypasses `/api`). See the full
[API reference](docs/src/content/docs/reference/api.md) for every route and
payload.

```sh
# 1. Create an asset (provider-qualified symbol, independent of datasets)
curl -X POST "$URL/api/assets" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"AAPL.US","provider":"eodhd","backfillStartDate":"2016-01-01"}'

# 2. Submit a complete workflow definition and make it the asset default
curl -X POST "$URL/api/workflows" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d @definition.json
curl -X PUT "$URL/api/workflow-defaults/asset/$WORKFLOW_ID" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

# 3. Create a portfolio with dated holdings snapshots
curl -X POST "$URL/api/portfolios" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Core","snapshot":{"holdingsDate":"2026-09-30","holdings":[{"symbol":"AAPL.US","weight":0.6},{"symbol":"MSFT.US","weight":0.4}]}}'

# 4. Start a run manually or inspect published datasets
curl -X POST "$URL/api/runs" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"'"$WORKFLOW_ID"'","subject":{"kind":"asset","symbol":"AAPL.US"}}'
curl "$URL/api/datasets/prices_eod/asset/AAPL.US" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -o AAPL.parquet "$URL/api/datasets/prices_eod/asset/AAPL.US/data" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

## The app

`$URL/` is a SvelteKit app protected by Cloudflare Access (`Cf-Access-Jwt-Assertion`
verified by the Worker against `DASHBOARD_ALLOWED_EMAILS`):

- **Home** (`/`): summary counts, workflow definitions, recent runs and recent publications.
- **Assets** (`/assets`, `/assets/:symbol`): registered assets, assigned workflows, published datasets and recent runs.
- **Portfolios** (`/portfolios`, `/portfolios/:id`): dated holdings snapshots, portfolio management, assigned workflows, publications and recent runs.
- **Workflows** (`/workflows`, `/workflows/:id`): read-only inspection of ordered steps, parameters, input/output connections, schedules, defaults and assignments.
- **Runs** (`/workflow-runs`, `/workflow-runs/:id`): status, waiting dependencies, retry attempts, errors, outputs and artifact/dataset links.
- **Explore data** (`/explore`): sort, date-filter and download published asset and portfolio Parquet datasets directly in the browser.
- **Docs** (`/docs/`): this documentation site.

## Deploying

GitHub Actions (`.github/workflows/deploy.yml`) runs `check` and `check-engine`
on every push and pull request, then applies D1 migrations and deploys the
Worker with the single Python container (`containers/engine/`):

| Branch                       | Target                               |
| ---------------------------- | ------------------------------------ |
| `main`                       | production (`data-service`)          |
| `develop`, `feat/*`, `fix/*` | dev environment (`data-service-dev`) |

Remote resources: the D1 database (`data-service-market-data`) and the two R2
buckets (`raw-market-data` with the 30-day `runs/` lifecycle rule and
`processed-market-data`). See [Deploying](docs/src/content/docs/operations/deploying.md)
and [The app and sign-in](docs/src/content/docs/operations/dashboard.md) for
secrets and Cloudflare Access setup.

## Checks

Run `pnpm format` after editing TypeScript, Svelte, config or Markdown files,
and `pnpm operations:generate` after changing Python operation Pydantic models.

```sh
pnpm operations:check   # Pydantic schemas -> generated TypeScript contracts
pnpm format:check
pnpm typecheck
pnpm test
pnpm workflow:fixture   # end-to-end local asset + portfolio fixture run (needs uv)
pnpm engine:test        # Python tests (needs uv)
pnpm engine:lint        # Ruff lint + format check (needs uv)
pnpm app:check
pnpm --filter app build
pnpm docs:build
```
