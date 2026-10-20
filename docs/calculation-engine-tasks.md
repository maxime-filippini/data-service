# Calculation engine: remaining work

The work left to build [the calculation engine spec](calculation-engine.md).
Each task below is sized for one session and one PR. Read the spec,
[CONTEXT.md](../CONTEXT.md) and [the engine README](../containers/engine/README.md)
before starting any of them.

## Status

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 1 | Engine container | | Done ([PR #17](https://github.com/maxime-filippini/data-service/pull/17)) |
| 2 | Portfolios and snapshots in D1 | | Done ([PR #18](https://github.com/maxime-filippini/data-service/pull/18)) |
| 3 | Engine in the Worker, `GET /calculation-types`, ad hoc `POST /calculate` | 1 (2 for `portfolioId`) | Done ([PR #19](https://github.com/maxime-filippini/data-service/pull/19)) |
| 4 | Calculations and runs | 2, 3 | Done ([PR #20](https://github.com/maxime-filippini/data-service/pull/20)) |
| 5 | Cron scheduling | 4 | In review (`feat/calc-cron`) |
| 6 | Dashboard pages | 2, 4 (results view needs only 4) | To do |
| 7 | Docs pass | all | To do |

Tasks 2 and 3 can run in parallel. Update this table when a task starts or
lands.

## Conventions

- Branch from `feat/calculation-engine` until PR #17 is merged, then from
  `develop`. Name branches `feat/calc-<task>`, for example `feat/calc-portfolios`.
- Follow the existing Worker patterns: Effect services with a `d1.ts`
  implementation (see `src/market-data/symbol-registry/` and
  `src/market-data/schedule/`), Hono routes under `src/routes/`, mounted
  twice in `src/index.ts` (management token) and
  `src/routes/dashboard/index.ts` (Cloudflare Access). Validate request
  bodies with Effect Schema ([effect-schema-validation.md](effect-schema-validation.md)).
- Tests go in `test/*.test.ts` (`pnpm test`); also run `pnpm typecheck`.
  Engine changes run `pnpm engine:test` and `pnpm engine:lint`.
- Migrations are numbered SQL files in `migrations/` (next is `0008`), with a
  comment above each table.
- Python: name dataframes `df` / `dfs`, never `frame`.
- The dev VM has no AVX, so the containers can't run locally. Test end to end
  on the dev environment, which CI deploys from `feat/*`.

## 2. Portfolios and snapshots in D1

Spec: "Portfolios".

- Migration `0005`: `portfolios` (id, name, created_at, updated_at),
  `portfolio_snapshots` (portfolio_id, holdings_date, created_at; unique per
  portfolio and date), `portfolio_holdings` (snapshot, symbol, weight). Weight
  is non-zero; a symbol appears once per snapshot.
- Service and routes under `/portfolios`:
  - list, create (name and optionally a first snapshot), rename, delete;
  - get one portfolio with its snapshots;
  - add a snapshot (`holdingsDate` plus holdings), delete a snapshot. No
    editing a snapshot: delete and add again.
- Checks: every symbol is a tracked `prices_eod` symbol (disabled symbols
  count as tracked); weights are finite and non-zero; one snapshot per date.
- Deleting a symbol from the registry that any snapshot holds returns `409`
  with the portfolios holding it. Disabling stays allowed. The registry has
  no delete route yet, so for now a foreign key from `portfolio_holdings` to
  `tracked_symbols` blocks the delete; whoever adds the route maps it to the
  `409` (the `portfolio_holdings_by_symbol` index finds the portfolios).
- Deleting a portfolio a calculation uses returns `409`. The `calculations`
  table doesn't exist until task 4, so task 4 adds this check.
- Add a function that loads a portfolio with its snapshots up to a date, in
  the engine's shape (`{ id, name, snapshots: [{ holdingsDate, holdings }] }`).
  Tasks 3 and 4 use it.

## 3. Engine in the Worker and ad hoc calculations

Spec: "Parts", "On demand → Ad hoc". Engine contract: the engine README.

- `src/engine-container.ts`: a `CalculationEngine` Container class like
  `MarketDataProcessor`, with `R2_*` and `PROCESSED_BUCKET` env vars (no raw
  bucket), internet enabled, and the heartbeat during long requests.
- `wrangler.jsonc`, top level and `env.dev`: a `containers` entry for
  `./containers/engine/Dockerfile`, a Durable Object binding (for example
  `CALCULATION_ENGINE`), and a new migration tag `v2` with
  `new_sqlite_classes: ["CalculationEngine"]`. Run `pnpm cf-typegen`.
- A small typed client for the engine: `GET /types`,
  `POST /types/:name/validate`, `POST /runs`, `POST /calculate`. Decide how
  many instances there are (start with one, like the processor).
- `GET /calculation-types`: the engine's type list, passed through.
- `POST /calculate`: body `{ type, params, asOf?, portfolio }` where
  `portfolio` is `{ portfolioId }` or `{ holdings }`. For `portfolioId`, load
  its snapshots up to `asOf` (task 2) and send them as `snapshots`; for
  `holdings`, pass them through. `asOf` defaults to the previous UTC day.
  Check holdings symbols are tracked before calling the engine. Timeout about
  60 seconds. Pass the `Accept` header through so Arrow works, and map engine
  `404`/`422`/`500` to the same statuses.
- If task 2 hasn't landed, ship `{ holdings }` first and add `portfolioId`
  after.

## 4. Calculations and runs

Spec: "Calculations", "Results", "On demand → Run now", "Scheduling → One
run at a time".

- Migration: `calculations` (id, name, type, params JSON, cron, enabled,
  timestamps), `calculation_portfolios` (calculation_id, portfolio_id, order),
  `calculation_runs` (run_id, calculation_id, trigger `schedule`/`manual`,
  as_of, params used, status `running`/`completed`/`partial`/`failed`/`skipped`,
  per-portfolio outcomes JSON, row_count, output_etag, error, created_at,
  completed_at). At most one `running` run per calculation (partial unique
  index, like migration `0002`).
- Routes under `/calculations`: list, create, get, update (params,
  portfolios, cron, enabled; the type can't change), delete; list a
  calculation's runs; get one run.
  - On create and update, validate params with the engine
    (`POST /types/:name/validate`) and store the returned params, which have
    defaults filled in. Check `takesPortfolio` against the portfolio list.
  - Validate the cron expression (5 fields). Parsing is shared with task 5.
- Add the `409` from task 2: deleting a portfolio used by a calculation.
- `POST /calculations/:id/runs` with optional `asOf` (default: previous UTC
  day). Returns the run ID straight away. If a run is already `running`,
  record a `skipped` run instead.
- Running: build the engine's run request (params, every portfolio with
  snapshots up to `asOf`, `outputKey` `calculation=<id>/data.parquet`), call
  `POST /runs`, and save the result on the run row. Runs can outlast a
  request, so run them off the request path. Pick a Workflow (like
  `ScheduledDownloadWorkflow`) or a queue (like processing) and explain the
  choice in the PR. Make sure a run stuck in `running` (Worker crash) is
  eventually marked failed, or it blocks every later run.
- Read the engine README "Runs" section for the result format and why the
  Worker still runs one run per calculation at a time.

## 5. Cron scheduling

Spec: "Scheduling".

- A "most recent slot at or before now" function. Task 4 added the 5-field
  parser (`src/calculations/cron.ts`, used to validate calculations), which
  returns the allowed values of each field; build on it. The minute field is
  ignored because the tick is hourly.
- On each hourly tick in `scheduled` (`src/index.ts`), for each enabled
  calculation: if its most recent slot is after the last slot it ran for,
  start a run as of the previous UTC day (`startRun` in
  `src/calculations/runs.ts`, trigger `schedule`) and record the slot. A missed slot
  runs once on the next tick, not once per missed slot. Store the last slot
  on `calculations` (task 4's migration or a new one).
- Keep the download trigger working if calculation scheduling fails, and the
  other way round.
- The dev environment has no cron triggers (`env.dev.triggers.crons` is
  empty). Test with unit tests and the run-now route, or a temporary trigger.

## 6. Dashboard

Spec: "Dashboard". Svelte app in `dashboard/`; views in `dashboard/src/views`,
API calls in `dashboard/src/lib/api.ts`, routes in `src/routes/dashboard`.

- **Portfolios:** list, create, rename, delete (showing the `409` message);
  a portfolio's snapshots with add (paste or edit symbol/weight rows) and
  delete.
- **Calculations:** list with type, cron, enabled and last run; create and
  edit with a JSON editor for params, showing the engine's validation errors
  and the type's params schema as help; enable/pause; run now with an
  optional as-of date.
- **Runs:** per calculation, with status, as-of date, params used and each
  portfolio's error.
- **Results:** the explorer only opens `dataset=<d>/symbol=<s>` today
  (`/datasets/:dataset/:symbol` in `src/routes/dashboard/index.ts`). Add a
  route for `calculation=<id>/data.parquet` and a link from the calculation
  page.
- Run `pnpm dashboard:check`.

## 7. Docs pass

- `docs/ARCHITECTURE.md`: add the engine container, the new D1 tables and the
  calculation flow.
- `README.md`: new routes and scripts.
- `docs/calculation-engine.md`: drop "being built" from the title; record any
  decisions made during tasks 2 to 6 (for example Workflow or queue for runs).
- `CONTEXT.md`: check the terms still match.

## Open questions

- **Request size.** The Worker sends every snapshot up to the as-of date in
  each engine request. That's fine for normal portfolios. If portfolios get
  large (daily snapshots of hundreds of names over years), write snapshots to
  R2 for the engine to read instead.
- **Snapshots are add-or-delete only.** This is in the spec but wasn't
  explicitly confirmed. Check with the owner before task 2 if unsure.
