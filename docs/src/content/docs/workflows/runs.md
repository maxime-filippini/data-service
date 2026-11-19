---
title: Workflow runs
description: Starting a definition for one subject, how its steps execute, run and step outcomes, artifacts, and running it locally against fixtures.
---

A run executes one workflow definition for one assigned subject and one
processing date. Runs are started by hand for now; the daily dispatcher comes
later, and the legacy [daily schedule](/docs/pipeline/schedule/) still owns
production downloads.

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
`subjectKind` and `subjectId`, `status`, `limit` up to 200).
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

Timestamps are left out above. A step is `pending` until reached, `running`
while it executes or retries (with the last attempt's `error`), then
`completed` or `failed`; steps a finished run never reached are `skipped`.

The run record keeps each step's small named outputs for inspection. It is
operational history, not a second checkpoint store: execution state lives in
Cloudflare Workflows.

Run history survives configuration changes. Runs have no foreign keys to
definitions, assignments or assets, and keep the workflow's name and subject,
so they stay readable after those are deleted. Deleting a definition, an
assignment or an asset is refused with `409` while it has an active run.

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

**Workflow runs** (`/workflow-runs`) lists runs with status and asset
filters. A run's page shows its status, error, processing date and each step
with its attempts, error and outputs, linking artifacts. Workflow and asset
pages list their recent runs.

## Running locally against fixtures

```sh
pnpm workflow:fixture
```

This runs the asset prices workflow (download, normalize, publish) through
the same API routes, executor, step implementations and Python operations as
the Worker, without credentials or network. It needs
[uv](https://docs.astral.sh/uv/):

1. it starts the real Python service with uv on a free localhost port;
2. it opens a local SQLite D1 database with the real migrations;
3. it creates an asset, a definition and an assignment through the
   management API;
4. it starts a run with `POST /api/runs`;
5. an in-process Workflow binding executes the run. The real EODHD adapter
   is answered from `fixtures/eodhd/<SYMBOL>.json`, the normalize step calls
   the Python service over HTTP, and the publish step copies its output to
   the local processed bucket.

Both languages read and write run artifacts in the same directory,
`r2/raw-market-data/`. Output goes to `.local/workflow-fixture/`, emptied
first:

| Path                                                                       | What                              |
| -------------------------------------------------------------------------- | --------------------------------- |
| `d1.sqlite`                                                                | The local database                |
| `r2/raw-market-data/runs/<runId>/download/raw.json`                        | The raw artifact                  |
| `r2/raw-market-data/runs/<runId>/normalize/prices.parquet`                 | Python's normalized output        |
| `r2/processed-market-data/dataset=prices_eod/symbol=<SYMBOL>/data.parquet` | The published dataset             |
| `run.json`                                                                 | The run and its step outcomes     |
| `publication.json`                                                         | The publication's metadata        |
| `api.log`                                                                  | Each API request and its response |

Options: `--out DIR`, `--symbol MSFT.US` (fixtures exist for `AAPL.US` and
`MSFT.US`) and `--date YYYY-MM-DD` (default `2024-01-10`). Retries happen
without waiting locally.

The local Workflow binding and Steps adapter follow the platform's rules
(checkpoints by step name, retries within the step's policy, no retry after a
terminal failure), but they are stand-ins. They are not evidence of
Cloudflare's durability; that needs a run on the dev environment.
