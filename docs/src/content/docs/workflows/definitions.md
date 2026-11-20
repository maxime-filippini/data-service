---
title: Assets and workflow definitions
description: Assets, complete workflow specifications, step types and their contracts, validation, assignments and defaults.
---

Assets, portfolios, and workflow definitions are the configuration surface of
the service. Whole workflow specifications are stored as data, validated
against the registered step catalog, assigned to assets or portfolios, and
[executed daily or on demand](/docs/workflows/runs/).

## Assets

An asset is an instrument identified by its provider-qualified symbol, such as
`AAPL.US` or `BRK-B.US`. Datasets are not part of an asset's identity, and
creating an asset downloads nothing and creates no portfolio. `provider` and
`backfillStartDate` are its download settings; `enabled: false` pauses it
without deleting it.

Creating an asset assigns it the [asset defaults](#defaults) in the same D1
batch. Deleting an asset removes its workflow assignments; deletion is refused
(`409`) while any portfolio snapshot holds the asset or while an active
workflow run references it. Allowed deletion preserves completed run history
and published datasets.

## Definitions

A workflow definition is submitted as one complete specification with `POST`
and replaced atomically with `PUT`:

```json
{
  "name": "Daily EOD prices",
  "scope": "asset",
  "enabled": true,
  "schedule": { "hourUtc": 4 },
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
      "inputs": {
        "raw": { "ref": "steps.download.outputs.raw" }
      }
    },
    {
      "id": "publish",
      "type": "publish-dataset",
      "params": { "dataset": "prices_eod" },
      "inputs": {
        "data": { "ref": "steps.normalize.outputs.prices" }
      }
    }
  ]
}
```

- `scope` is the subject kind it runs for: `asset` or `portfolio`. The kinds
  are listed once, in `src/workflows/subjects.ts`; a new kind also needs a
  migration (see the [data model](/docs/reference/data-model/)).
- `schedule.hourUtc` is the whole UTC hour (0–23) at which it is
  [dispatched](/docs/workflows/runs/#scheduled-dispatch) daily for each
  enabled assignment.
- `steps` execute sequentially in the listed order. Each has a unique `id`, a
  registered `type`, literal `params`, and `inputs` bindings. Omitted `params`
  and `inputs` are saved as `{}`.

Each input binding is either a literal, `{ "value": ... }`, or an explicit
reference, `{ "ref": ... }`, to:

- a run-context field: `context.subject` (the run's asset or portfolio) or
  `context.processingDate` (its UTC processing date), or
- a named output of an earlier step: `steps.<id>.outputs.<name>`.

References are not expressions: there is no property traversal, no forward
reference, no loop, and no conditional branch. One output may feed several
later steps.

## Step types and contracts

Step types are registered in TypeScript (`src/workflows/registry/`). Each
declares the scopes it runs in, an Effect Schema for its `params`, and named
`inputs` and `outputs`, each carrying an explicit contract identity (such as
`asset-subject`, `date`, or `raw-prices-eod`). A reference connects only to an
input accepting that contract identity; there is no structural subtyping.

`GET /api/step-types` returns the catalog: every step type with its parameter
JSON Schema and ports, every contract schema, and the run-context fields per
scope.

| Step type                        | Scopes           | Inputs                                                                                        | Outputs                                                                          |
| -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `download-prices`                | asset            | `asset` (`asset-subject`), `throughDate` (`date`)                                             | `raw` (`raw-prices-eod`)                                                         |
| `normalize-prices`               | asset            | `raw` (`raw-prices-eod`)                                                                      | `prices` (`prices-eod`)                                                          |
| `publish-dataset`                | asset, portfolio | `data` (`publishable-dataset`)                                                                | `publication` (`dataset-publication`)                                            |
| `portfolio-holdings`             | portfolio        | `portfolio` (`portfolio-subject`), `processingDate` (`date`)                                  | `holdingsDate` (`date`), `holdings` (`holdings`)                                 |
| `wait-for-asset-publications`    | portfolio        | `holdings` (`holdings`), `processingDate` (`date`)                                            | `publications` (`published-asset-prices`)                                        |
| `calculate-portfolio-volatility` | portfolio        | `holdings` (`holdings`), `publications` (`published-asset-prices`), `processingDate` (`date`) | `data` (`portfolio-volatility-data`), `summary` (`portfolio-volatility-summary`) |

- `download-prices` fetches the asset's prices from its provider from the
  asset's `backfillStartDate` (or optional `startDate` param) through
  `throughDate`, stores the validated response as a run artifact, and outputs
  its reference.
- `normalize-prices` and `publish-dataset` normalize raw prices in Python and
  publish them to `prices_eod`. See
  [Python operations and published datasets](/docs/workflows/datasets/).
- `portfolio-holdings` loads the portfolio's snapshot effective at
  `processingDate`, stores it as a JSON run artifact
  (`portfolio-holdings/v1`), and outputs its reference as `holdings` plus the
  effective `holdingsDate`.
- `wait-for-asset-publications` reads the `holdings` artifact and waits durably
  for matching `prices_eod` publications from `workflowId` (default 2-hour
  timeout, configurable via `timeoutSeconds`). It outputs a JSON artifact
  reference (`published-asset-prices/v1`) to the publication list. See
  [Dependency waits](/docs/workflows/runs/#dependency-waits).
- `calculate-portfolio-volatility` reads both artifacts and runs ex-ante
  volatility in Python over the effective holdings and matching published
  prices, outputting a Parquet artifact reference (`data`) and inline
  `summary`. Pass `data` to `publish-dataset` with
  `dataset: "portfolio_volatility"`.

## Validation

`POST` and `PUT` reject malformed JSON shapes with `400`. A well-formed
specification that violates registry rules gets `422` with every issue and its
`path`:

- duplicate step IDs or unknown step types;
- a step type outside the definition's `scope`;
- malformed or unknown `params`;
- missing required inputs or undeclared input names;
- a literal violating its input contract;
- a malformed reference, unknown context field, missing/self/forward step
  reference, or unknown output name;
- a contract mismatch against the input's declared contract and `accepts` list.

Validation runs before persistence, so a rejected `PUT` leaves the existing
definition intact.

## Assignments

An assignment links one definition to one existing subject of its scope, at
most once. Individual assignments can be disabled to pause one subject without
editing the shared definition. A definition's scope cannot change while it has
assignments or is a default (`409`). Deleting a definition removes its
assignments and default link; deletion of a definition or assignment is refused
(`409`) while it has an active run, and allowed deletion keeps run history.

`GET /api/workflow-assignments` lists assignments with their definition's
`schedule` and `workflowEnabled`, filtered by `workflowId` or by subject
(`subjectKind` and `subjectId`).

## Defaults

Defaults are explicit per subject kind (`asset` or `portfolio`). Creating a new
subject assigns its kind's defaults in the same D1 batch.

```sh
curl -X PUT "$URL/api/workflow-defaults/asset/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/workflow-defaults" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X DELETE "$URL/api/workflow-defaults/asset/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X POST "$URL/api/workflow-defaults/asset/apply" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

- Adding or removing a default affects future subjects only.
- `POST /api/workflow-defaults/<kind>/apply` idempotently adds missing default
  assignments to existing subjects without re-enabling deliberately disabled
  ones.

## In the app

- **Assets** (`/assets`, `/assets/:symbol`) list assets, their assigned
  workflows and daily UTC schedules, published datasets, and recent runs.
- **Portfolios** (`/portfolios`, `/portfolios/:id`) manage dated holdings and
  show assigned workflows, published datasets, and recent runs.
- **Workflows** (`/workflows`, `/workflows/:id`) show read-only definitions,
  defaults, assignments, and ordered steps with their parameters and visible
  input/output links.

See [Management API](/docs/reference/api/#assets) for all routes.
