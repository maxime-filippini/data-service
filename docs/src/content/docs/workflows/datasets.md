---
title: Python operations and published datasets
description: The uniform Python operation contract, generated TypeScript contracts, normalization, publication and dataset retrieval.
---

The asset workflow downloads prices, normalizes them in Python and publishes
them as the asset's current `prices_eod` dataset:

```json
{
  "name": "Daily asset prices",
  "scope": "asset",
  "enabled": true,
  "schedule": { "hourUtc": 2 },
  "steps": [
    {
      "id": "download",
      "type": "download-prices",
      "inputs": {
        "asset": { "ref": "context.subject" },
        "throughDate": { "ref": "context.processingDate" }
      }
    },
    {
      "id": "normalize",
      "type": "normalize-prices",
      "inputs": { "raw": { "ref": "steps.download.outputs.raw" } }
    },
    {
      "id": "publish",
      "type": "publish-dataset",
      "params": { "dataset": "prices_eod" },
      "inputs": { "data": { "ref": "steps.normalize.outputs.prices" } }
    }
  ]
}
```

## Python operations

One Python service (the engine package, `containers/engine`) exposes
workflow operations through one contract. TypeScript step types call them;
Python never sequences steps, waits for data or retries.

`POST /operations/{name}` takes:

```json
{
  "execution": { "runId": "<run uuid>", "stepId": "normalize" },
  "inputs": {
    "raw": {
      "id": "runs/<run>/download/raw.json",
      "format": "json",
      "schema": "raw-prices-eod/v1"
    }
  },
  "params": {}
}
```

and answers with small JSON, typically an artifact reference:

```json
{
  "prices": {
    "id": "runs/<run>/normalize/prices.parquet",
    "format": "parquet",
    "schema": "prices-eod/v1"
  }
}
```

A failure is never a `200`. Its body is
`{"error": {"kind", "message", "issues"}}`:

| Status | `kind`      | Meaning                                                  |
| ------ | ----------- | -------------------------------------------------------- |
| `404`  | `terminal`  | Unknown operation                                        |
| `422`  | `terminal`  | Invalid request (with `issues`) or a domain error        |
| `503`  | `transient` | Storage trouble; a retry may succeed                     |
| `500`  | `transient` | An unexpected error (it may be an outage as much as bug) |

The step retries `transient` failures within its policy and stops the run on
`terminal` ones. A response that can't be read, or no response at all, is
transient; a `200` whose body breaks its contract is terminal.

Outputs go to locations fixed by the run and step
(`runs/<runId>/<stepId>/<name>.<ext>`), so calling an operation again after a
lost response rewrites the same object and returns the same reference. There
is no exactly-once promise across HTTP; operations are written to be repeated.

`GET /operations` lists each operation with its request and response JSON
Schemas. In the Worker the service is the `CALCULATION_ENGINE` container; it
reads and writes run artifacts in the raw bucket (`ARTIFACT_BUCKET`). Locally
it runs with uv and reads and writes files under `ARTIFACT_ROOT`. The
volatility operation reads published asset prices from `PROCESSED_BUCKET` in
the container or `PROCESSED_ROOT` locally.

### Contracts generated from Pydantic

The Pydantic models in `data_service_engine/operations/` are the source of
truth. Two committed files follow from them:

- `src/operations/schemas.json`: their JSON Schemas
  (`uv run engine export-schemas`);
- `src/operations/contracts.generated.ts`: Effect Schemas generated from
  that file, giving both TypeScript types and runtime validation.

```sh
pnpm operations:generate   # after changing an operation's models
pnpm operations:check      # fails if either file is stale
```

Both files are generated locally and committed with the model change that
produced them: run `pnpm operations:generate` before committing. CI only
checks them. Its `check` job runs `pnpm operations:check`, which re-exports
the Pydantic schemas and fails if either file is stale. The Python tests also
fail when `schemas.json` differs from the models, and
`test/operation-contracts.test.ts` fails when the generated module differs
from `schemas.json`.

The generator's own tests (`test/operation-contract-generator.test.ts`) run
it on the export of `containers/engine/tests/contract_shapes.py`, models that
cover each field shape a contract may use, and check that the generated
schemas accept and reject the same values as Pydantic. A shape the generator
cannot check, such as a string format other than `date` or `date-time`, makes
generation fail rather than produce a schema that accepts anything.

Step registrations use the generated parameter and artifact schemas. The
volatility summary schema is generated too. The client validates each request
before sending it and each response before returning it.

## Steps

| Step type                        | Inputs                                                                              | Outputs                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `normalize-prices`               | `raw` (`raw-prices-eod`)                                                            | `prices` (`prices-eod`)                                              |
| `calculate-portfolio-volatility` | Effective `holdings` and `holdingsDate`, price `publications`, and `processingDate` | `data` (Parquet reference), `summary` (volatility and return window) |
| `publish-dataset`                | `data` (`publishable-dataset`)                                                      | `publication` (`dataset-publication`)                                |

`normalize-prices` calls `normalize-prices-eod`. It validates the raw
envelope (it must belong to the run and its rows must lie in the requested
range), builds the `prices_eod` table sorted by date, keeping the later row on
a duplicate date, and writes it as Parquet. The transformation is the legacy
processor's, moved into the engine; the processor keeps its copy until
cutover.

`calculate-portfolio-volatility` applies the processing date's effective
weights to historical daily returns. It uses the existing ex-ante volatility
formula, with the same `window`, `annualisation`, `decay` and
`normalise_weights` parameters. The operation requires one matching dated
price reference for each holding. It resolves those identities to the current
published objects and uses observations up to the processing date. Insufficient
history, missing prices and invalid weights are terminal errors. A successful
call returns a small JSON summary and a Parquet artifact reference.

`publish-dataset` publishes for the run's own subject and processing date.
Choose `prices_eod` for an asset or `portfolio_volatility` for a portfolio.
The step accepts the corresponding normalized prices or volatility artifact.

1. reads the run artifact (missing, for example expired: terminal);
2. copies it to the dataset's stable location in the processed bucket:
   `dataset=prices_eod/symbol=<SYMBOL>/data.parquet`, the object the app's
   explorer and calculations already read, or
   `dataset=portfolio_volatility/portfolio=<ID>/data.parquet` for a portfolio;
3. only then records the publication in D1: dataset, subject, processing
   date, producing workflow, run and step, and the object's ETag and size.

Neither write is conditional, so a retry repeats both. If the metadata write
fails after the copy, the step's retry copies the same bytes again and
records the publication. Storage and D1 are not one transaction. A run whose
download, normalization or calculation fails never reaches the publish step, so the
previous publication stays as it was. No rule stops two workflows from
publishing the same dataset; avoid configuring that.

## Retrieving datasets

| Method | Path                                                  | Returns                                                      |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------ |
| `GET`  | `/api/datasets`                                       | Publications (`subjectKind`, `subjectId`, `dataset` filters) |
| `GET`  | `/api/datasets/:dataset/:subjectKind/:subjectId`      | One publication's metadata                                   |
| `GET`  | `/api/datasets/:dataset/:subjectKind/:subjectId/data` | The current data (Parquet, with an ETag)                     |

```json
{
  "dataset": "prices_eod",
  "subject": { "kind": "asset", "symbol": "AAPL.US" },
  "processingDate": "2024-01-10",
  "producer": {
    "workflowId": "…",
    "workflowName": "Daily asset prices",
    "runId": "…",
    "stepId": "publish"
  },
  "format": "parquet",
  "schema": "prices-eod/v1",
  "size": 2703,
  "etag": "…",
  "publishedAt": "…"
}
```

No temporary run location is exposed. Publications and data have no foreign
keys to assets, definitions or runs, so they stay after the asset or the
workflow is deleted, and after the run's artifacts expire. `/data` serves
whatever is at the stable location, including files the legacy processor
built before any publication was recorded.

The app serves the same routes at `/app-api/publications` (its
`/app-api/datasets` streams files for the explorer). An asset's page lists
its published datasets with links to the producing run, the explorer and the
Parquet file. A run's page links a publish step's output to them.

## Adding a step type

For a Python-backed step, follow `portfolio_volatility.py` in
`data_service_engine/operations/`. Define Pydantic models for the inputs,
params and outputs. Use `execution` to derive stable run artifact IDs and
raise `TerminalError` for invalid inputs or `TransientError` for retriable
I/O. Register the `Operation` in the Python registry and run
`pnpm operations:generate`. In `src/workflows/registry/`, define a step
with `defineStepType`, give its ports the matching contracts, call
`PythonOperations.invoke` with resolved inputs, and add the step to
`builtInStepTypes`. Test the new call through Python HTTP and the workflow API.

For an Effect-only step, follow `portfolio-holdings.ts`. Define its params,
supported scopes and named ports with `defineStepType`. Use the existing Effect
service in its `implementation` and map its failures to terminal or transient
step errors. Add it to `builtInStepTypes`. Check that a definition can bind its
outputs and run it through the API with a fixture.

## Temporary artifacts expire

Run artifacts live under `runs/` in the raw bucket and expire 30 days after
they are written, through an R2 lifecycle rule. See
[Storage layout](/docs/reference/storage/#lifecycle).
