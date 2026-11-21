---
title: Data model
description: The D1 tables that hold the control plane, and the rules they enforce.
---

D1 (`data-service-market-data`) holds every piece of state: the universe, the
schedule, runs, jobs, portfolios and calculations. It holds **no market data
and no results**; those live in R2. Migrations are in `migrations/`.

## Market data

```mermaid
erDiagram
  tracked_symbols {
    text dataset PK
    text symbol PK
    text provider
    int enabled
    text backfill_start_date
  }
  download_schedule {
    int id PK "always 1"
    int hour_utc
    int paused
  }
  schedule_runs {
    text run_id PK "also the Workflow ID"
    text trigger "schedule | manual"
    text run_date
    text snapshot_to
    text status "running | completed | failed"
    int queued_count
    int skipped_count
  }
  ingestion_runs {
    text run_id PK
    text dataset
    text symbol
    text provider
    text requested_from
    text requested_to
    text status "fetching | completed | failed"
    text object_key
    text object_etag
    int row_count
  }
  processing_jobs {
    text job_id PK
    text dataset
    text symbol
    text run_id FK
    text status "queued | processing | completed | failed"
    text output_etag
  }
  tracked_symbols ||--o{ ingestion_runs : "downloaded by"
  ingestion_runs ||--o{ processing_jobs : "rebuilt by"
```

## Portfolios and calculations

```mermaid
erDiagram
  tracked_symbols {
    text dataset PK
    text symbol PK
  }
  portfolios {
    text portfolio_id PK
    text asset_symbol "unique when set; single-asset portfolio"
    text name
  }
  portfolio_snapshots {
    text portfolio_id PK, FK
    text holdings_date PK
  }
  portfolio_holdings {
    text portfolio_id PK, FK
    text holdings_date PK, FK
    text symbol PK, FK
    text dataset FK "always prices_eod"
    real weight "non-zero"
  }
  calculations {
    text calculation_id PK
    text name
    text type
    text params_json
    text cron
    int enabled
    text last_scheduled_slot
  }
  calculation_portfolios {
    text calculation_id PK, FK
    text portfolio_id PK, FK
    int position
  }
  calculation_runs {
    text run_id PK "also the Workflow ID"
    text calculation_id FK
    text trigger "schedule | manual"
    text as_of
    text params_json
    text status "running | completed | partial | failed | skipped"
    text portfolios_json
    int row_count
    text output_etag
  }
  portfolios ||--o{ portfolio_snapshots : has
  portfolio_snapshots ||--|{ portfolio_holdings : contains
  tracked_symbols ||--o{ portfolio_holdings : "held as"
  calculations ||--o{ calculation_portfolios : "runs over"
  portfolios ||--o{ calculation_portfolios : "used by"
  calculations ||--o{ calculation_runs : has
```

Deleting a portfolio cascades to its snapshots and holdings; deleting a
calculation cascades to its portfolio links and runs. The foreign keys from
`portfolio_holdings` to `tracked_symbols` and from `calculation_portfolios` to
`portfolios` don't cascade, so a held symbol or a used portfolio can't be
deleted.

## Assets and workflow definitions

```mermaid
erDiagram
  assets {
    text symbol PK
    text provider
    text backfill_start_date
    int enabled
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
    text error
  }
  workflow_definitions ||--o{ workflow_assignments : "assigned by"
  workflow_definitions ||--o{ workflow_defaults : "default for"
  workflow_runs ||--o{ workflow_run_steps : "reached"
```

Steps, with their params and bindings, are JSON in `steps_json`; identity,
scope and schedule are ordinary columns. Deleting a definition, an asset or
(later) a portfolio removes its assignments in the same batch. The scope
update is conditional on there being no assignments, so a racing assignment
can't end up with the wrong kind of subject; the same goes for default links.

`workflow_defaults` lists, per subject kind, the definitions assigned to each
new subject. Creating an asset inserts its default assignments in the same
batch, before the asset row and only if the asset does not exist yet.
Scheduled runs record their daily occurrence in `scheduled_for`.

A run captures its definition's name and steps when it claims the
assignment, and has no foreign keys to definitions, assignments or assets, so
deleting configuration never deletes run history. Those deletions are
conditional on there being no active run. Step rows record each reached
step's attempts, error and small outputs; Cloudflare Workflows keeps the
checkpoints. Large step data lives in R2 under `runs/<runId>/`.

`dataset_publications` holds the current publication of each dataset per
subject (primary key `dataset, subject_kind, subject_id`): its processing
date, the producing `workflow_id`, `run_id` and `step_id`, the copied run
artifact, the format and schema, and the published object's ETag and size.
It is written after the object and replaced by the next publication. Like
runs it has no foreign keys, so deleting configuration keeps it.

## Concurrency rules

Partial unique indexes enforce the service's "one at a time" rules in the
database, so two Workers racing can't both win:

| Index                              | Rule                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| `ingestion_runs_one_fetching`      | One `fetching` run per `(dataset, symbol)`                         |
| `processing_jobs_one_active`       | One `queued` or `processing` job per `(dataset, symbol)`           |
| `schedule_runs_one_per_day`        | One `schedule`-triggered run per `run_date`                        |
| `calculation_runs_one_running`     | One `running` run per calculation                                  |
| `workflow_runs_one_active`         | One `queued`, `running` or `waiting` run per assignment            |
| `workflow_runs_one_per_occurrence` | One run (queued or skipped) per assignment and schedule occurrence |
