---
title: Workflow download cutover and rollback
description: Reviewed procedure to migrate production download registrations to workflows and roll back safely.
---

This runbook moves automatic end-of-day price downloads from the legacy
`download_schedule` / queue pipeline to the workflow engine as a **two-way
door**. Legacy routes, queues, Workflows, tables, and the processor container
stay deployed until workflow publication and recovery are verified in
production (ticket #39 removes them afterward).

:::caution
Executing the production steps below modifies live Cloudflare resources and
requires maintainer review and explicit deployment authorization. Until that
review and switchover occur, `WORKFLOW_DISPATCH` stays `"off"` in
`wrangler.jsonc`.
:::

## Production baseline (observed 2026-11-19)

Read-only inspection of production resources on **2026-11-19** established the
following starting state:

| Resource                      | Observed baseline                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| D1 `data-service-market-data` | At migration `0007_calculation_schedule.sql` (migrations `0008`–`0014` pending).                 |
| `tracked_symbols`             | **50** enabled `eodhd` registrations (`dataset = 'prices_eod'`), 0 disabled, 0 non-`prices_eod`. |
| `download_schedule`           | `hour_utc = 4`, `paused = 0` (`04:00 UTC` daily schedule active).                                |
| `portfolios`                  | **1** real portfolio with dated holdings in `portfolio_holdings`.                                |
| `calculations`                | **0** saved calculations (0 arbitrary cron schedules).                                           |
| R2 `processed-market-data`    | Default multipart abort rule only; no object expiration rule.                                    |
| R2 `raw-market-data`          | Verify and apply the 30-day `runs/` lifecycle rule before cutover.                               |

## What the migration changes (and preserves)

Applying the workflow migration after D1 migrations `0008`–`0014`:

- Seeds `assets` from `tracked_symbols` (`dataset = 'prices_eod'`), preserving
  `symbol`, `provider`, `backfill_start_date`, `enabled`, `created_at`, and
  `updated_at` without overwriting conflicting custom assets.
- Seeds one deterministic standard asset workflow definition
  (`7f8b4e30-2c1a-4d6e-9b5a-100000000001`, `"Daily EOD prices"`, scope
  `"asset"`, `schedule_hour_utc = 4`, `enabled = 1`, steps:
  `download` -> `normalize` -> `publish` to `prices_eod`).
- Registers that workflow definition in `workflow_defaults` for `asset`.
- Creates explicit `workflow_assignments` for every migrated `prices_eod`
  asset without re-enabling any deliberately disabled assignment (disabled
  assets remain blocked by `assets.enabled = 0`).
- Removes positively identified generated single-asset portfolios created by
  migration `0008` **only when unused** (zero references in
  `calculation_portfolios`, `calculation_runs`, `workflow_assignments`,
  `workflow_runs`, and `dataset_publications`).
- Reports any unsupported calculation cron schedules or non-`prices_eod`
  registrations rather than silently translating them.
- Preserves the real portfolio and its `portfolio_holdings` rows untouched (it
  never duplicates rows into `portfolio_asset_holdings`), all retained
  `ingestion_runs`, `processing_jobs`, `schedule_runs`, `dataset_publications`,
  and canonical Parquet paths
  (`dataset=prices_eod/symbol=<SYMBOL>/data.parquet`).

## 1. Back up production D1 and rehearse locally

Export a full backup of production D1 before changing anything:

```sh
mkdir -p .local/cutover-2026-11-19
pnpm exec wrangler d1 export data-service-market-data --remote \
  --output .local/cutover-2026-11-19/prod-backup-0007.sql
```

Load a copy into a local SQLite file, apply migrations `0008`–`0014`, and
rehearse dry-run inventory, idempotent apply, cutover, and rollback locally:

```sh
sqlite3 .local/cutover-2026-11-19/rehearsal.sqlite \
  < .local/cutover-2026-11-19/prod-backup-0007.sql

for f in migrations/0008_*.sql migrations/0009_*.sql migrations/0010_*.sql \
         migrations/0011_*.sql migrations/0012_*.sql migrations/0013_*.sql \
         migrations/0014_*.sql; do
  sqlite3 .local/cutover-2026-11-19/rehearsal.sqlite < "$f"
done

# Dry-run inventory (read-only)
pnpm workflow:migrate --db .local/cutover-2026-11-19/rehearsal.sqlite --dry-run

# First apply: expect 50 assets, 1 workflow, 1 default, 50 assignments,
# 50 unused generated single-asset portfolios removed, 1 real portfolio retained.
pnpm workflow:migrate --db .local/cutover-2026-11-19/rehearsal.sqlite --apply

# Second apply: confirm strict idempotency ("mutations": 0).
pnpm workflow:migrate --db .local/cutover-2026-11-19/rehearsal.sqlite --apply

# Rehearse switchover and rollback against the local copy.
pnpm workflow:migrate --db .local/cutover-2026-11-19/rehearsal.sqlite --cutover
pnpm workflow:migrate --db .local/cutover-2026-11-19/rehearsal.sqlite --rollback
```

Review the dry-run JSON report and confirm:

- `trackedSymbols.unsupportedDatasets` is `[]`
- `assets.conflicts` is `[]`
- `calculations.unsupportedSchedules` is `[]`
- `portfolios.real` lists the 1 real portfolio with expected snapshot/holding counts
- `portfolios.generatedSingleAssetRetained` is `[]` and
  `portfolios.unverifiedAssetPortfolios` is `[]`
- `retainedData.portfolioAssetHoldings` remains `0` after `--apply`

## 2. Verify R2 lifecycle rules

Check lifecycle rules on both production R2 buckets:

```sh
pnpm exec wrangler r2 bucket lifecycle list raw-market-data
pnpm exec wrangler r2 bucket lifecycle list processed-market-data
```

Confirm `processed-market-data` has **no** object expiration rule (only the
default multipart abort rule). On `raw-market-data`, confirm `runs/` contains
no retained historical data (retained raw history starts with `dataset=`), then
add the 30-day expiry rule for temporary workflow artifacts if missing:

```sh
pnpm exec wrangler r2 bucket lifecycle add raw-market-data \
  expire-temporary-run-artifacts runs/ --expire-days 30
```

Re-run `wrangler r2 bucket lifecycle list raw-market-data` and verify the rule
matches only prefix `runs/` with a 30-day (`2,592,000`-second) expiration.

## 3. Apply D1 migrations 0008–0014 with `WORKFLOW_DISPATCH` still `"off"`

With `WORKFLOW_DISPATCH` still `"off"` in `wrangler.jsonc`, apply schema
migrations and deploy the Worker:

```sh
pnpm db:migrate:remote
pnpm run deploy
```

At this point the legacy `download_schedule` still owns the `04:00 UTC` daily
download and workflow dispatch stays disabled.

## 4. Review and apply the idempotent data migration on production D1

Generate the deterministic SQL script, inspect it, and execute it against
production D1:

```sh
pnpm workflow:migrate --emit-sql apply \
  > .local/cutover-2026-11-19/apply.sql
cat .local/cutover-2026-11-19/apply.sql

pnpm exec wrangler d1 execute data-service-market-data --remote \
  --file .local/cutover-2026-11-19/apply.sql
```

Verify post-migration state via read-only SQL and the authenticated API/app:

```sh
pnpm exec wrangler d1 execute data-service-market-data --remote --command "
SELECT
  (SELECT count(*) FROM assets) AS assets,
  (SELECT count(*) FROM workflow_definitions) AS definitions,
  (SELECT count(*) FROM workflow_defaults WHERE subject_kind = 'asset') AS asset_defaults,
  (SELECT count(*) FROM workflow_assignments WHERE subject_kind = 'asset') AS asset_assignments,
  (SELECT count(*) FROM portfolios WHERE asset_symbol IS NULL) AS real_portfolios,
  (SELECT count(*) FROM portfolios WHERE asset_symbol IS NOT NULL) AS generated_portfolios,
  (SELECT count(*) FROM portfolio_holdings) AS legacy_holdings,
  (SELECT count(*) FROM portfolio_asset_holdings) AS asset_holdings;
"
```

Expected counts for the 2026-11-19 baseline: `assets = 50`, `definitions = 1`,
`asset_defaults = 1`, `asset_assignments = 50`, `real_portfolios = 1`,
`generated_portfolios = 0`, `asset_holdings = 0`. Also check `/api/assets`,
`/api/workflows`, `/api/workflow-defaults`, `/api/workflow-assignments`,
`/api/portfolios`, and the app views (`/assets`, `/workflows`, `/portfolios`).

Optional pre-switchover sanity check: trigger one manual run for a single
asset via `POST /api/runs` for workflow
`7f8b4e30-2c1a-4d6e-9b5a-100000000001` and confirm `GET /api/runs/<runId>`
reaches `completed` and `GET /api/datasets/prices_eod/asset/<SYMBOL>` updates
the publication metadata without breaking existing Parquet consumers.

## 5. Execute the explicit switchover

The Worker's hourly scheduled handler (`src/scheduled.ts`) enforces **strict
mutual exclusion**: when `WORKFLOW_DISPATCH === "on"`, `scheduled()` runs
`scheduledWorkflowTick` and never invokes legacy `triggerScheduledRun`. Still,
pause `download_schedule` first so database state and Worker configuration
agree at every moment:

1. Generate and apply the cutover SQL (pauses legacy `download_schedule`):

   ```sh
   pnpm workflow:migrate --emit-sql cutover \
     > .local/cutover-2026-11-19/cutover.sql
   pnpm exec wrangler d1 execute data-service-market-data --remote \
     --file .local/cutover-2026-11-19/cutover.sql
   ```

   Alternatively, call `PATCH /api/schedule` with `{"paused": true}`.

2. In `wrangler.jsonc` (production `vars` only), change `"WORKFLOW_DISPATCH"`
   from `"off"` to `"on"`, review the diff, and deploy:

   ```sh
   pnpm run deploy
   ```

## 6. Verify scheduled publication and recovery

After the next `04:00 UTC` cron tick:

- Check `GET /api/runs?trigger=schedule` and confirm 50 scheduled runs were
  dispatched for the `04:00 UTC` occurrence (with no legacy `schedule_runs` row
  created for that day).
- Confirm all 50 runs reach `completed`, or verify retry/recovery behavior for
  any transient provider/storage error (and manual rerun via
  `POST /api/runs/<runId>/rerun` if needed).
- Check `GET /api/datasets?dataset=prices_eod` and spot-check
  `GET /api/datasets/prices_eod/asset/<SYMBOL>/data` to confirm canonical
  Parquet files at `dataset=prices_eod/symbol=<SYMBOL>/data.parquet` serve
  fresh data.
- Verify the app's `/workflows`, `/workflow-runs`, and `/assets` views reflect
  the runs and publications accurately.

Record the verified scheduled publication date, run outcomes, and any recovery
observations before starting legacy removal (ticket #39).

## Rollback procedure

If workflow dispatch or publication encounters an issue after switchover, roll
back immediately without losing data or consumer compatibility:

1. Flip `"WORKFLOW_DISPATCH"` back to `"off"` in `wrangler.jsonc` and redeploy:

   ```sh
   pnpm run deploy
   ```

2. Unpause the legacy `download_schedule`:

   ```sh
   pnpm workflow:migrate --emit-sql rollback \
     > .local/cutover-2026-11-19/rollback.sql
   pnpm exec wrangler d1 execute data-service-market-data --remote \
     --file .local/cutover-2026-11-19/rollback.sql
   ```

   Alternatively, call `PATCH /api/schedule` with `{"paused": false}`.

3. Verify `GET /api/schedule` shows `paused: false` and `hourUtc: 4`, and
   confirm the next hourly tick (or `POST /api/schedule/runs`) runs through the
   legacy pipeline. All `tracked_symbols`, `portfolio_holdings`,
   `ingestion_runs`, `processing_jobs`, and canonical Parquet files in
   `processed-market-data` remain intact throughout.
