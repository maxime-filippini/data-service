---
title: Python operations and published datasets
description: The uniform Python operation contract, generated TypeScript contracts, normalization, volatility, explicit publication and dataset retrieval.
---

One Python service (`containers/engine/`) handles both data normalization and
numerical calculations behind a uniform HTTP operation contract, and the shared
`publish-dataset` step publishes finished Parquet datasets independently of
temporary run artifacts.

## Python operations

TypeScript step types call the Python container; Python never sequences steps,
waits for dependencies, or manages retries.

`POST /operations/{name}` accepts:

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

and returns small JSON (typically an artifact reference and optional inline
summary):

```json
{
  "prices": {
    "id": "runs/<run>/normalize/prices.parquet",
    "format": "parquet",
    "schema": "prices-eod/v1"
  }
}
```

Failures are never hidden inside a `200` response. Every non-2xx response
returns `{"error": {"kind", "message", "issues"}}`:

| Status | `kind`      | Meaning                                                       |
| ------ | ----------- | ------------------------------------------------------------- |
| `404`  | `terminal`  | Unknown operation                                             |
| `422`  | `terminal`  | Invalid request (with `issues`) or deterministic domain error |
| `503`  | `transient` | Storage failure; safe to retry                                |
| `500`  | `transient` | Unexpected error (bounded retries apply)                      |

The TypeScript client retries `transient` failures (including transport errors
and unreadable responses) within the step's retry policy and stops immediately
on `terminal` failures (including a `200` body violating the response schema).

Outputs are written to deterministic `runs/<runId>/<stepId>/<name>.<ext>` keys,
so repeating a call after a lost HTTP response overwrites the same artifact and
returns the same reference.

`GET /operations` lists every registered operation with its request and
response JSON Schemas. In Cloudflare, the container reads/writes run artifacts
in `ARTIFACT_BUCKET` (`raw-market-data`). Operations that need published prices
get a separate read-only reader for `PROCESSED_BUCKET` (`processed-market-data`),
so the run artifact store never reaches a published dataset. Locally,
`ARTIFACT_ROOT` and `PROCESSED_ROOT` point to directories shared with the
TypeScript local adapters.

### Contracts generated from Pydantic

The Pydantic models in `containers/engine/src/data_service_engine/operations/`
are the single source of truth:

- `src/operations/schemas.json` — exported by `uv run engine export-schemas`;
- `src/operations/contracts.generated.ts` — Effect Schemas generated from
  `schemas.json`, providing both TypeScript types and runtime validation.

```sh
pnpm operations:generate   # regenerate after changing Python models
pnpm operations:check      # CI check: fails if either committed file is stale
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

## Registered operations and publication step

| Step type                        | Python operation                 | Inputs                                                       | Outputs                                                              |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `normalize-prices`               | `normalize-prices-eod`           | `raw` (`raw-prices-eod`)                                     | `prices` (`prices-eod`)                                              |
| `calculate-portfolio-volatility` | `calculate-portfolio-volatility` | Effective `holdings`, price `publications`, `processingDate` | `data` (Parquet reference), `summary` (volatility and return window) |
| `publish-dataset`                | _(Effect-only)_                  | `data` (`publishable-dataset`)                               | `publication` (`dataset-publication`)                                |

- **`normalize-prices-eod`** validates the raw download envelope (matching
  `runId`, entries within `requestedRange`), builds a date-sorted `prices_eod`
  table (keeping the last row on duplicate dates), and writes `prices.parquet`.
- **`calculate-portfolio-volatility`** applies the effective snapshot's weights
  to aligned historical daily returns of `adjusted_close` up to
  `processingDate` using the `ex_ante_vol` formula (`window`, `annualisation`,
  `decay`, `normalise_weights`). Missing prices, insufficient history, or zero
  weight sums (when normalizing) fail terminally.
- **`publish-dataset`** publishes for the run's subject and processing date
  (`prices_eod` for assets, `portfolio_volatility` for portfolios):
  1. reads the run artifact (missing or expired → terminal failure);
  2. copies the Parquet bytes to the stable published key in
     `processed-market-data`:
     - `dataset=prices_eod/symbol=<SYMBOL>/data.parquet`
     - `dataset=portfolio_volatility/portfolio=<ID>/data.parquet`
  3. records metadata in D1 `dataset_publications` (dataset, subject,
     processing date, producing workflow/run/step, ETag, size) **only after**
     the R2 copy succeeds.

If the metadata write fails after the object write, the step's retry repeats
both cleanly. If download, normalization, or volatility fails earlier in the
run, `publish-dataset` never runs and the previous published dataset stays
intact. No exclusive-publisher lock is enforced; avoid assigning two workflows
to publish the same dataset for the same subject.

## Retrieving datasets

| Method | Path                                                  | Returns                                                      |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------ |
| `GET`  | `/api/datasets`                                       | Publications (`subjectKind`, `subjectId`, `dataset` filters) |
| `GET`  | `/api/datasets/:dataset/:subjectKind/:subjectId`      | One publication's metadata                                   |
| `GET`  | `/api/datasets/:dataset/:subjectKind/:subjectId/data` | Current Parquet bytes (supports `If-None-Match` / `304`)     |

No temporary `runs/` path is exposed. Publication records and published Parquet
objects survive temporary artifact expiration (30 days) and allowed asset,
portfolio, or workflow deletion.

The app mounts the same routes at `/app-api/publications`. Asset pages,
portfolio pages, run pages, and the [Explore data](/docs/operations/dashboard/)
page all read published datasets through `/app-api/publications`.

## Adding a step or operation

See [Adding a new step type](/docs/maintaining/#adding-a-new-step-type) in the
maintainer guide for the step-by-step checklist for both Python-backed
operations and Effect-only steps.

## Temporary artifact retention

Run artifacts live under `runs/` in `raw-market-data` and expire automatically
30 days after they are written via one R2 lifecycle rule. See
[Storage layout](/docs/reference/storage/#lifecycle).
