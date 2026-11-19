---
title: Workflow runs
description: Starting a definition for one subject by hand or on its daily schedule, how its steps execute, run and step outcomes, artifacts, and running it locally against fixtures.
---

A run executes one workflow definition for one assigned subject and one
processing date. Runs are started by hand or
[dispatched daily](#scheduled-dispatch) by the hourly tick. Dispatch is off
in every deployed environment: the legacy
[daily schedule](/docs/pipeline/schedule/) still owns production downloads.

## Starting a run

```sh
curl -X POST "$URL/api/runs" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"'$ID'","subject":{"kind":"asset","symbol":"AAPL.US"},"processingDate":"2026-11-18"}'
```

The response is `202` with the run straight away; the run executes in its own
Cloudflare Workflow instance, whose ID is the run ID. `processingDate`
defaults to today's UTC date.

A run needs an enabled definition, an enabled assignment and, for an asset,
an enabled asset. Otherwise the request fails (`404` for an unknown
definition or assignment, `409` for something disabled) and nothing is
recorded.

Only one run per assignment can be active (`queued`, `running` or
`waiting`). A submission while one is active is recorded as a `skipped` run
whose `error` names the active run, and nothing executes. Runs of different
assignments run independently.

`POST /api/runs/:runId/rerun` starts a new run of the same assignment and
processing date from the beginning, with the definition as it is now. Its
`rerunOf` names the earlier run. There is no resuming from a chosen step.

## Scheduled dispatch

The Worker's hourly cron starts a durable dispatcher
(`WorkflowDispatchWorkflow`, bound as `WORKFLOW_DISPATCHES`) when the
`WORKFLOW_DISPATCH` var is `on`.
It is `off` in `wrangler.jsonc` for both production and dev, so the new
dispatcher and the legacy scheduled download never both download. Switching
it on is a step of the download cutover, together with stopping the legacy
schedule. Tests and the [fixture command](#running-locally-against-fixtures)
run it with a controlled clock.

The dispatcher uses one instance ID per UTC tick hour, so a repeated trigger
or a lost launch response does not start a second dispatcher for that hour.
It uses the original tick time throughout, including after replay or across
midnight, rather than moving assignments to a newer occurrence partway
through dispatch.

Each dispatch:

1. **Reconciles** active runs (`queued`, `running`, `waiting`) against their
   Workflow instances, as a submission does (see
   [Reconciling launches](#reconciling-launches)), so an uncertain launch is
   relaunched under its ID and a stopped instance's run fails without waiting
   for a new submission.
2. **Finds** each enabled definition's latest due occurrence: today at its
   `schedule.hourUtc` once that hour has started, otherwise yesterday's. The
   run's processing date is the occurrence's UTC date, so a 23:00 workflow
   ticked at 00:10 runs for the previous day.
3. **Claims and launches** every enabled assignment (of an enabled
   definition and, for an asset, an enabled asset) that has not claimed that
   occurrence, through the same claim and launch path as a manual run, with
   `trigger: "schedule"` and `scheduledFor` set to the occurrence.

Rules that follow:

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

1. **Claim.** One D1 batch claims the assignment's active-run slot and
   captures the definition's name and steps into the run record, or records
   a skipped run. A partial unique index makes concurrent claims safe.
2. **Launch.** The Worker creates the Workflow instance with the run ID. If
   the create call fails but the instance exists, it launched. If the outcome
   can't be confirmed, the run stays `queued`.
3. **Execute.** The instance's first step loads the captured run (so a
   replay uses the same sequence, even if the definition was edited since)
   and marks it `running`. Then each step runs in the saved order, each as
   one durable step:
   - inputs are resolved (a literal, `context.subject`,
     `context.processingDate`, or an earlier step's output) and validated
     against their contracts;
   - the step type's implementation runs;
   - its outputs are validated against their contracts and must serialize to
     32 KB or less.
4. **Record.** The run ends `completed`, or `failed` with the failing step
   and its error.

Completed steps are checkpointed by Cloudflare Workflows: when an instance
replays (after a restart or eviction), they return their saved outputs
without running again.

### Retries and failures

Each step type owns its retry policy. The default is three retries with
exponential backoff (10 s, 20 s, 40 s) and a 10-minute timeout per attempt,
for transient failures: provider requests, storage and database errors. A
terminal failure stops the run at once without retries: invalid params or
inputs, an unknown step type, an output that breaks its contract or the size
bound, or a deterministic domain error such as a provider response that
fails raw-data validation. A transient failure that outlasts its retries also
fails the run.

Step bodies may run more than once, so their writes tolerate repeats:
artifacts go to IDs fixed by the run and step, and step records are upserts.

### Reconciling launches

Before claiming, a submission checks the assignment's active run against its
Workflow instance:

- an instance that stopped (`complete`, `errored` or `terminated`) without
  recording an outcome fails the run, which releases the assignment;
- an instance whose status can't be read is not evidence that it is absent,
  so the claim is kept. A `queued` run is launched again under the same ID,
  which can't create a second instance.

## Run and step outcomes

`GET /api/runs` lists runs, newest first (filters: `workflowId`,
`subjectKind` and `subjectId`, `status`, `trigger` (`manual` or
`schedule`), `limit` up to 200). For example, the occurrences skipped because
a run was still active: `?trigger=schedule&status=skipped`.
`GET /api/runs/:runId` returns a run with every captured step:

```json
{
  "id": "fe8a9dca-0389-454b-aabf-427493a2f082",
  "workflowId": "a702df57-f79b-45c6-ac40-41ff3ae5dd5b",
  "workflowName": "Daily asset prices",
  "subject": { "kind": "asset", "symbol": "AAPL.US" },
  "processingDate": "2024-01-10",
  "trigger": "manual",
  "rerunOf": null,
  "scheduledFor": null,
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

Timestamps are left out above. A scheduled run has `"trigger": "schedule"`
and `scheduledFor`, the occurrence it was dispatched for (such as
`"2024-01-10T02:00:00.000Z"`). A step is `pending` until reached, `running`
while it executes or retries (with the last attempt's `error`), `waiting`
while it waits for inputs, then
`completed` or `failed`; steps a finished run never reached are `skipped`.

The run record keeps each step's small named outputs for inspection. It is
operational history, not a second checkpoint store: execution state lives in
Cloudflare Workflows.

Run history survives configuration changes. Runs have no foreign keys to
definitions, assignments or assets, and keep the workflow's name and subject,
so they stay readable after those are deleted. Deleting a definition, an
assignment or an asset is refused with `409` while it has an active run.

## Dependency waits

A portfolio workflow can read its effective holdings and wait for each of
the resulting assets' current `prices_eod` publications. A publication
qualifies when its producer is a completed run of the specified upstream
workflow for that asset and processing date, and the stored object matches
the publication record. A refresh on a non-trading day can qualify.

The first check fixes an absolute deadline. Cloudflare Workflows sleeps
between checks, at most one minute at a time, and reuses the deadline on
replay. A waiting step's `waiting` field shows `deadline` and `missing`
entries with each symbol and reason. The step returns the matching
publication references and continues when ready. A timeout fails the run
and leaves the last missing inputs in the outcome. The checks do not
launch upstream runs.

Only publications ready by the deadline can satisfy the wait. Platform
scheduling and infrastructure retries can delay the final outcome. The
step's attempt count tracks starts of the wait itself. Each dependency check
is a separate platform checkpoint.

The resolved holdings and matching publication-reference lists are JSON run
artifacts in R2. Only their small references are checkpointed and recorded as
step outputs, keeping even a 5,000-asset portfolio below the application's
32 KiB step-output limit. These JSON artifacts are validated against their
versioned schema and capped at 8 MiB each to bound Worker memory use.
The wait reads the holdings artifact on each check;
editing the portfolio does not change the inputs of an existing wait. A retry
after the holdings write reuses that snapshot too. Missing, expired or invalid
holdings artifacts fail the run instead of re-reading the portfolio's live state.
Both artifacts can be downloaded through the run-artifact API below and expire
under the same 30-day lifecycle as other temporary run artifacts.

## Artifacts

Data too large for a step output is stored as a temporary run artifact under
`runs/<runId>/<stepId>/<name>.<ext>` in the raw bucket, and the step outputs
an artifact reference (`id`, `format`, `schema`). The download step's `raw`
artifact is the provider response in the same envelope as legacy raw objects:
`version`, `runId`, `dataset`, `provider`, `symbol`, `requestedRange`,
`receivedAt` and the validated `entries`.

`GET /api/runs/:runId/steps/:stepId/artifacts/:output` returns the artifact
an output references. Only references recorded as a run's outputs are
read, so no storage paths are accepted from callers.

Run artifacts are temporary: they expire 30 days after they are written
(see [Storage layout](/docs/reference/storage/#lifecycle)). Data meant to
last is [published](/docs/workflows/datasets/) to a separate location.

## In the app

**Workflow runs** (`/workflow-runs`) lists runs with status, trigger and
asset filters; scheduled runs show their occurrence's hour, and a skipped
run's reason is on its status badge. A run's page shows its status, error, processing date and each step
with its attempts, error and outputs, linking artifacts. Workflow and asset
pages list their recent runs.

## Running locally against fixtures

```sh
pnpm workflow:fixture
```

The command runs the asset prices and portfolio volatility workflows through
the same API routes, executor, step implementations and Python operations as
the Worker. It uses [uv](https://docs.astral.sh/uv/) and fixture data.

1. It starts the Python service with uv on a free localhost port.
2. It opens a local SQLite database with the real D1 migrations.
3. Through the management API it creates a definition, makes it the
   [asset default](/docs/workflows/definitions/#defaults) and creates the
   assets, which assigns it.
4. It starts the asset runs with `POST /api/runs` or, with `--scheduled`, runs one
   [dispatch tick](#scheduled-dispatch) at 03:00 UTC on the date, which
   dispatches the definition's 02:00 occurrence.
5. An in-process Workflow binding executes the asset runs. The EODHD adapter
   is answered from `fixtures/eodhd/<SYMBOL>.json`, the normalize step calls
   the Python service over HTTP, and the publish step copies its output to
   the local processed bucket.
6. The command creates a portfolio with two dated holdings snapshots and
   starts its workflow, which reads the effective holdings and resolves the
   published asset data for that date. The volatility step uses both outputs
   and the processing date to calculate the result in Python. The final step
   publishes the portfolio's `portfolio_volatility` dataset.

Both languages share `r2/raw-market-data/` for run artifacts and
`r2/processed-market-data/` for published datasets. The command empties
`.local/workflow-fixture/` before writing the following files.

| Path                                                                                | What                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `d1.sqlite`                                                                         | The local database                                          |
| `r2/raw-market-data/runs/<runId>/download/raw.json`                                 | The raw artifact                                            |
| `r2/raw-market-data/runs/<runId>/normalize/prices.parquet`                          | Python's normalized output                                  |
| `r2/processed-market-data/dataset=prices_eod/symbol=<SYMBOL>/data.parquet`          | The published dataset                                       |
| `run.json`                                                                          | The run and its step outcomes                               |
| `publication.json`                                                                  | The publication's metadata                                  |
| `asset-runs.json`                                                                   | Run outcomes for all fixture assets                         |
| `portfolio.json`                                                                    | Dated portfolio snapshots                                   |
| `portfolio-run.json`                                                                | Effective holdings, price references and volatility outputs |
| `portfolio-publication.json`                                                        | Published volatility metadata                               |
| `r2/raw-market-data/runs/<runId>/volatility/volatility.parquet`                     | Python's volatility output                                  |
| `r2/processed-market-data/dataset=portfolio_volatility/portfolio=<ID>/data.parquet` | Published volatility for the portfolio                      |
| `api.log`                                                                           | Each API request and its response                           |

Options: `--out DIR`, `--symbol MSFT.US` (fixtures exist for `AAPL.US` and
`MSFT.US`), `--date YYYY-MM-DD` (default `2024-01-10`) and `--scheduled`. Retries happen
without waiting locally.

The local Workflow binding and Steps adapter follow the platform's rules
(checkpoints by step name, retries within the step's policy, no retry after a
terminal failure), but they are stand-ins. They are not evidence of
Cloudflare's durability; that needs a run on the dev environment.

### Tracing checkpoints and replay

```sh
pnpm workflow:trace
```

Uses the same setup to show how a portfolio run waits for an asset run. The
portfolio run starts first, so its first dependency check finds nothing. Each
durable sleep then works like an eviction: the execution stops, a minute of
virtual time passes, and the next execution replays the body from the top.
The trace prints every checkpoint as it runs, is stored or is replayed, every
D1 statement and Python call in between, and the run's D1 rows and stored
checkpoint names after each execution.

`--scenario timeout` never runs the asset, so the wait fails at a
2.5-minute deadline. `--flaky` fails the first Python call to show a retry
inside one checkpoint. `--sql writes` or `--sql none` hides D1 reads or all
statements. The trace is also written without colours to
`.local/workflow-trace/trace.log`.
