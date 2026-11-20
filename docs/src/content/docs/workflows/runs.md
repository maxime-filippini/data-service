---
title: Workflow runs
description: Starting a definition for one subject by hand or on its daily schedule, how steps execute, failure recovery, dependency waits, artifacts, and the local fixture scenario.
---

A **workflow run** executes one workflow definition for one assigned subject
and one **processing date**. Runs are started manually through the API or
[dispatched daily](#scheduled-dispatch) by the Worker's hourly cron.

## Starting a run

```sh
curl -X POST "$URL/api/runs" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"'$ID'","subject":{"kind":"asset","symbol":"AAPL.US"},"processingDate":"2026-11-18"}'
```

The response is `202` immediately; the run executes asynchronously in its own
Cloudflare Workflow instance (`DefinitionRunWorkflow`), whose instance ID
equals the run ID. `processingDate` defaults to today's UTC date.

A run requires an enabled definition, an enabled assignment, and (for an asset)
an enabled asset. Otherwise the request fails (`404` for an unknown definition
or assignment, `409` for something disabled) without recording a run.

Only one run per assignment may be active (`queued`, `running`, or `waiting`).
Submitting while one is active records a `skipped` run whose `error` names the
active run, and executes nothing. Different assignments run concurrently.

`POST /api/runs/:runId/rerun` starts a new run of the same assignment and
processing date from the beginning using the current definition, recording the
previous run ID in `rerunOf`. Arbitrary mid-workflow resume is not supported.

## Scheduled dispatch

The Worker's hourly cron (`0 * * * *`) starts a durable dispatcher
(`WorkflowDispatchWorkflow`, bound as `WORKFLOW_DISPATCHES`) whenever
`WORKFLOW_DISPATCH` is `"on"` (the default in `wrangler.jsonc`; set `"off"` only
as an emergency kill switch to pause all scheduled dispatch). Tests and the
[fixture command](#running-locally-against-fixtures) run it with a controlled
clock.

The dispatcher uses one instance ID per UTC tick hour, so a repeated trigger
or a lost launch response does not start a second dispatcher for that hour.
It uses the original tick time throughout, including after replay or across
midnight, rather than moving assignments to a newer occurrence partway
through dispatch.

Each dispatch:

1. **Reconciles** active runs (`queued`, `running`, `waiting`) against their
   Workflow instances so uncertain launches are retried under the same ID and
   stopped instances release their assignment slot.
2. **Selects** each enabled definition's latest due occurrence: today at
   `schedule.hourUtc` once that hour has started, otherwise yesterday's. The
   run's processing date is the occurrence's UTC date, so a `23:00 UTC`
   workflow ticked at `00:10 UTC` runs for the previous day.
3. **Claims and launches** every enabled assignment that has not yet claimed
   that occurrence, through the same claim-and-launch path as manual runs,
   recording `trigger: "schedule"` and `scheduledFor`.

Dispatch guarantees:

- **Once per occurrence.** A unique index on
  `(workflow_id, subject_kind, subject_id, scheduled_for)` makes the claim a
  no-op when the assignment already claimed the occurrence, so repeated or
  concurrent ticks cannot dispatch it twice.
- **Latest only.** Missed occurrences are never replayed: after downtime,
  the next tick runs only the latest occurrence.
- **Overlap.** An occurrence due while the assignment's previous run (manual
  or scheduled) is still active is recorded as a `skipped` run with its
  `scheduledFor` and an `error` naming the active run. Equally, a manual
  submission while a scheduled run is active is skipped.
- **Disabled.** Disabled definitions, assignments and assets are not
  dispatched and nothing is recorded. Once enabled again, an assignment
  catches up the latest occurrence if it never claimed it; the same goes for
  a new assignment (for example an asset created after its default's hour)
  and a definition whose hour moved later in the day.
- **Batched, not capped per tick.** The dispatcher reconciles active runs
  and claims due assignments in batches of at most 100, continuing until
  both scans are exhausted. For example, 500 assignments are dispatched in
  five batches by the same dispatcher, without waiting for five hourly
  ticks. Each assignment still executes its own workflow independently;
  there is no cross-assignment barrier between steps.
- **Checkpointed.** Selecting and processing each batch are separate durable
  steps. After interruption, the dispatcher reuses the selected batch and
  resumes from its checkpoints. Occurrence claims and run IDs remain
  retry-safe if a batch executes again before its checkpoint is saved.
- **Forward progress.** Keyset cursors advance past each selected page,
  including assignments rejected after selection and active runs kept
  active. Removing claimed rows or keeping older runs active cannot skip
  later pages or keep the dispatcher cycling over the first batch. A
  rejected assignment is reported and can be reconsidered by a later tick.

## How a run executes

1. **Claim.** One atomic D1 batch claims the assignment's active-run slot and
   captures the definition's `workflowName` and `steps` into `workflow_runs`
   (or records a `skipped` run).
2. **Launch.** The Worker creates the `DefinitionRunWorkflow` instance with
   `id = runId`. If launch confirmation is lost, reconciliation checks the same
   deterministic ID without creating duplicates.
3. **Execute.** The first durable step loads the captured run (so edits to the
   definition never alter an in-flight run's step sequence) and marks it
   `running`. Each step then runs sequentially as a durable Cloudflare step:
   - resolves input bindings (`literal`, `context.*`, `steps.<id>.outputs.*`)
     and validates them against step contracts;
   - executes the step implementation;
   - validates outputs against contracts and enforces the 32 KiB inline output
     size bound.
4. **Record.** The run finishes `completed`, or `failed` with the failing step
   and diagnostic error.

Completed steps are checkpointed by Cloudflare Workflows: on replay after an
eviction or wait, completed steps return their checkpointed outputs without
running again.

### Retries and failures

Step types decide which failures are transient and which are terminal; the
executor applies one step policy to every step's attempts. Each execution
environment can supply its own, and the default is **3 retries with
exponential backoff** (`10 s`, `20 s`, `40 s`) and a 10-minute attempt timeout
for transient failures (provider HTTP errors, R2/D1 errors, container network
or 5xx failures).

Terminal failures throw `NonRetryableError` and stop the run immediately
without retrying: invalid parameters or inputs, unknown step types, schema or
size-bound violations, or deterministic domain errors (such as malformed
provider rows or insufficient return history for volatility).

Because step bodies may run more than once when a response is lost or a retry
occurs, all writes are retry-safe: run artifacts use deterministic
`runs/<runId>/<stepId>/<name>.<ext>` keys, and D1 step records and publication
rows are upserts.

### Reconciling launches

Before claiming (and on every hourly tick), reconciliation inspects active runs
against Cloudflare Workflows:

- if the instance stopped (`complete`, `errored`, or `terminated`) without
  recording an outcome in D1, reconciliation marks the run `failed` and
  releases the assignment claim;
- if instance status lookup itself is unavailable, reconciliation **never**
  releases the claim;
- a `queued` run whose instance does not exist yet is relaunched under the same
  `runId`.

## Run and step outcomes

`GET /api/runs` lists runs newest first (filters: `workflowId`, `subjectKind` +
`subjectId`, `status`, `trigger`, `limit` up to 200). `GET /api/runs/:runId`
returns the run and every captured step:

```json
{
  "id": "fe8a9dca-0389-454b-aabf-427493a2f082",
  "workflowId": "7f8b4e30-2c1a-4d6e-9b5a-100000000001",
  "workflowName": "Daily EOD prices",
  "subject": { "kind": "asset", "symbol": "AAPL.US" },
  "processingDate": "2024-01-10",
  "trigger": "schedule",
  "rerunOf": null,
  "scheduledFor": "2024-01-10T04:00:00.000Z",
  "status": "completed",
  "error": null,
  "steps": [
    {
      "position": 1,
      "id": "download",
      "type": "download-prices",
      "status": "completed",
      "attempts": 1,
      "outputs": {
        "raw": {
          "id": "runs/fe8a9dca-0389-454b-aabf-427493a2f082/download/raw.json",
          "format": "json",
          "schema": "raw-prices-eod/v1"
        }
      },
      "error": null
    }
  ]
}
```

Step statuses: `pending`, `running` (shows last attempt's `error` during
retries), `waiting`, `completed`, `failed`, or `skipped` (not reached after an
earlier failure). Run records have no foreign keys to definitions, assignments,
assets, or portfolios, so operational history stays readable after allowed
configuration deletion.

## Dependency waits

`wait-for-asset-publications` lets a portfolio workflow wait explicitly for
upstream `prices_eod` publications for every asset returned by
`portfolio-holdings`:

- A publication qualifies only when the specified upstream `workflowId` has a
  `completed` run for that asset and `processingDate`, **and** the current
  `dataset_publications` record matches that run and stored object ETag.
- A successful refresh on a non-trading day qualifies (market-calendar
  completeness remains the numerical operation's responsibility).
- The first check checkpoints an absolute deadline (default 2 hours,
  configurable via `timeoutSeconds`). Cloudflare sleeps durably between checks
  (at most 1 minute per sleep) and reuses the same deadline across replays.
- While waiting, the step records `waiting: { deadline, missing }` naming each
  missing symbol and reason. On timeout, the run fails with the missing symbols
  identified. Dependency checks **never** launch upstream workflows.

## Artifacts

Large step outputs are persisted under `runs/<runId>/<stepId>/<name>.<ext>` in
`raw-market-data`, and steps pass small JSON artifact references
(`{ id, format, schema }`) through checkpoints.

`GET /api/runs/:runId/steps/:stepId/artifacts/:output` retrieves an artifact
referenced by a recorded step output (callers never supply arbitrary storage
paths). Temporary run artifacts expire after 30 days through R2's lifecycle
rule; see [Storage layout](/docs/reference/storage/#lifecycle).

## In the app

**Runs** (`/workflow-runs`, `/workflow-runs/:id`) filters runs by asset
symbol, status, and trigger, and shows every step's status, waiting deadline
and missing inputs, retry count, errors, inline outputs (such as volatility
summaries), artifact downloads, and published dataset links.

## Running locally against fixtures

```sh
pnpm workflow:fixture
```

Runs the complete asset and portfolio workflow path locally through the real
API routes, executor, step implementations, and Python HTTP service (started
via [uv](https://docs.astral.sh/uv/)) without Cloudflare credentials or live
EODHD access:

1. Starts `containers/engine` on a free localhost port backed by local
   directories.
2. Applies all real D1 migrations (`0001`–`0014`) to `.local/workflow-fixture/d1.sqlite`.
3. Creates the `download → normalize → publish` asset workflow through
   `POST /api/workflows`, sets it as the asset default, and creates fixture
   assets (`AAPL.US`, `MSFT.US`).
4. Runs both asset workflows (manually, or with `--scheduled` through
   `scheduledWorkflowTick`), normalizing EODHD fixture responses in Python and
   publishing `prices_eod` Parquet files.
5. Creates a portfolio with two dated holdings snapshots and runs the
   `portfolio-holdings → wait-for-asset-publications → calculate-portfolio-volatility → publish-dataset`
   workflow, publishing `portfolio_volatility`.

All outputs are written to `.local/workflow-fixture/` (emptied on each run):

| Path                                                                                | What                                                     |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `d1.sqlite`                                                                         | Local SQLite database with real D1 migrations            |
| `r2/raw-market-data/runs/<runId>/download/raw.json`                                 | Raw EODHD fixture envelope                               |
| `r2/raw-market-data/runs/<runId>/normalize/prices.parquet`                          | Python's normalized prices artifact                      |
| `r2/processed-market-data/dataset=prices_eod/symbol=<SYMBOL>/data.parquet`          | Published asset prices dataset                           |
| `r2/raw-market-data/runs/<runId>/volatility/volatility.parquet`                     | Python's portfolio volatility artifact                   |
| `r2/processed-market-data/dataset=portfolio_volatility/portfolio=<ID>/data.parquet` | Published portfolio volatility dataset                   |
| `run.json`, `asset-runs.json`                                                       | Asset workflow run outcomes                              |
| `publication.json`, `portfolio-publication.json`                                    | Publication metadata (API shape)                         |
| `portfolio.json`, `portfolio-run.json`                                              | Portfolio snapshots, dependencies and volatility outputs |
| `api.log`                                                                           | Every management API call and HTTP status                |

Options: `--out DIR`, `--symbol MSFT.US`, `--date YYYY-MM-DD` (default
`2024-01-10`), and `--scheduled`. The in-process Workflow stand-in mirrors
checkpointing and retries without waiting; real Cloudflare platform durability
is verified by the [Cloudflare smoke test](/docs/operations/workflow-smoke/).
