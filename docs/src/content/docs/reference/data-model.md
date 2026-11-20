---
title: Data model
description: The D1 tables holding assets, portfolios, workflows, runs and publications, plus concurrency constraints and retained historical tables.
---

D1 (`data-service-market-data`) holds all configuration, operational run
history, and publication metadata. It holds **no market data or Parquet
files**; those live in R2. Migrations live in `migrations/` (`0001`–`0014`).

## Active workflow tables

```mermaid
erDiagram
  assets {
    text symbol PK
    text provider
    text backfill_start_date
    int enabled
  }
  portfolios {
    text portfolio_id PK
    text asset_symbol "null for normal portfolios"
    text name
  }
  portfolio_snapshots {
    text portfolio_id PK, FK
    text holdings_date PK
  }
  portfolio_asset_holdings {
    text portfolio_id PK, FK
    text holdings_date PK, FK
    text symbol PK, FK
    real weight "non-zero"
  }
  workflow_definitions {
    text workflow_id PK
    text name
    text scope "asset | portfolio"
    int enabled
    int schedule_hour_utc "0-23"
    text steps_json "ordered steps"
  }
  workflow_assignments {
    text workflow_id PK, FK
    text subject_kind PK "asset | portfolio"
    text subject_id PK "symbol or portfolio ID"
    int enabled
  }
  workflow_defaults {
    text subject_kind PK "asset | portfolio"
    text workflow_id PK, FK
  }
  workflow_runs {
    text run_id PK "also the Workflow instance ID"
    text workflow_id
    text workflow_name "captured"
    text subject_kind
    text subject_id
    text processing_date
    text trigger "manual | schedule"
    text rerun_of
    text scheduled_for "occurrence, scheduled runs only"
    text status "queued | running | waiting | completed | failed | skipped"
    text error
    text steps_json "captured steps"
  }
  workflow_run_steps {
    text run_id PK, FK
    text step_id PK
    int position
    text step_type
    text status "running | waiting | completed | failed"
    int attempts
    text outputs_json "small named outputs"
    text waiting_json "deadline + missing symbols"
    text error
  }
  dataset_publications {
    text dataset PK
    text subject_kind PK
    text subject_id PK
    text processing_date
    text workflow_id
    text run_id
    text step_id
    text source_artifact
    text format
    text schema
    text etag
    int size
    text published_at
  }
  portfolios ||--o{ portfolio_snapshots : has
  portfolio_snapshots ||--o{ portfolio_asset_holdings : contains
  assets ||--o{ portfolio_asset_holdings : "held as"
  workflow_definitions ||--o{ workflow_assignments : "assigned by"
  workflow_definitions ||--o{ workflow_defaults : "default for"
  workflow_runs ||--o{ workflow_run_steps : "reached"
```

Key persistence rules:

- **Definitions as data.** `workflow_definitions` stores ordered steps, params,
  and input bindings in `steps_json`, while searchable fields (`scope`,
  `enabled`, `schedule_hour_utc`) are ordinary columns. Scope changes are
  guarded conditionally against existing assignments and defaults.
- **Default assignment on create.** Creating an asset or portfolio inserts its
  `workflow_defaults` assignments in the same D1 batch.
- **History independent of configuration.** `workflow_runs` and
  `dataset_publications` intentionally have **no foreign keys** to `assets`,
  `portfolios`, `workflow_definitions`, or `workflow_assignments`. Deleting
  configuration is blocked while an active run exists, and allowed deletion
  retains complete run history and current publication metadata.
- **Holdings references.** `portfolio_asset_holdings` references `assets(symbol)`
  without cascade delete, and `D1AssetStoreLive.remove` checks both
  `portfolio_asset_holdings` and historical `portfolio_holdings` before
  allowing asset deletion.

The subject kinds are listed once, in `SUBJECT_KINDS`
(`src/workflows/subjects.ts`). `CHECK` constraints repeat them on
`workflow_definitions.scope` and on `subject_kind` in `workflow_assignments`,
`workflow_defaults`, `workflow_runs` and `dataset_publications`. Adding or
removing a kind therefore needs a migration that rebuilds those tables,
because SQLite can't alter a `CHECK` constraint.

## Concurrency rules

Partial unique indexes enforce the service's "one at a time" rules atomically
in D1 so concurrent Workers cannot race:

| Index                              | Rule                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `workflow_runs_one_active`         | One `queued`, `running`, or `waiting` run per assignment               |
| `workflow_runs_one_per_occurrence` | One run (`queued` or `skipped`) per assignment and schedule occurrence |

## Retained pre-workflow tables

Migrations `0001`–`0008` are preserved untouched so existing D1 databases never
lose stored history:

- `portfolio_holdings`: read alongside `portfolio_asset_holdings` via
  `UNION ALL` in `D1PortfoliosLive` and checked by `D1AssetStoreLive` so migrated
  portfolios continue working without duplicating rows. All new snapshots are
  written to `portfolio_asset_holdings`.
- `tracked_symbols`, `download_schedule`, `schedule_runs`, `ingestion_runs`,
  `processing_jobs`, `calculations`, `calculation_portfolios`,
  `calculation_runs`: retained in D1 as historical tables; no active runtime
  code writes to them. `src/workflows/migration.ts` and `pnpm workflow:migrate`
  remain available for historical inventory and audit.
