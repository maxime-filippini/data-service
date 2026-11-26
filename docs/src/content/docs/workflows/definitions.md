---
title: Assets and workflow definitions
description: Assets, complete workflow specifications, step types and their contracts, validation, assignments and defaults.
---

The workflow service is being introduced beside the current downloader (see
the [specification](https://github.com/maxime-filippini/data-service/blob/develop/docs/specs/workflow-service.md)).
Configuration can be created, validated, assigned and inspected, and an
assignment can be [run by hand](/docs/workflows/runs/) or
[dispatched daily](/docs/workflows/runs/#scheduled-dispatch). Scheduled
dispatch is switched off in every deployed environment
(`WORKFLOW_DISPATCH` is `off`): the current
[daily schedule](/docs/pipeline/schedule/) still owns downloads until the
cutover.

## Assets

An asset is an instrument identified by its symbol, such as `AAPL.US` or
`BRK-B.US`. Provider-qualified symbols are kept exactly as given. Datasets are
not part of an asset's identity, and creating one downloads nothing and
creates no portfolio. `provider` and `backfillStartDate` are its download
settings; `enabled: false` pauses it without deleting it. Creating an asset
assigns it the [asset defaults](#defaults). Deleting an asset removes its
workflow assignments; it is refused (`409`) while a run for the asset is
active.

Assets are separate from the legacy `tracked_symbols` registry, which keeps
working unchanged.

## Definitions

A workflow definition is one complete specification, submitted with `POST`
and replaced as a whole with `PUT`:

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
      "params": { "startDate": "2010-01-04" },
      "inputs": {
        "asset": { "ref": "context.subject" },
        "throughDate": { "ref": "context.processingDate" }
      }
    }
  ]
}
```

- `scope` is the subject kind it runs for: `asset` or `portfolio`.
- `schedule.hourUtc` is the whole UTC hour (0–23) at which it is
  [dispatched](/docs/workflows/runs/#scheduled-dispatch) daily for each
  enabled assignment.
- `steps` run in the listed order. Each has a unique `id`, a registered
  `type`, literal `params` and `inputs` bindings. Omitted `params` and
  `inputs` are saved as `{}`.

Each input binding is either a literal, `{ "value": ... }`, or a reference,
`{ "ref": ... }`, to:

- a run-context field: `context.subject` (the run's asset or portfolio) or
  `context.processingDate` (its UTC processing date), or
- a named output of an earlier step: `steps.<id>.outputs.<name>`.

References are not expressions: no property access, no forward references.
One output can feed several later steps.

## Step types and contracts

Step types are registered in TypeScript (`src/workflows/registry`). Each
declares the scopes it runs in, an Effect Schema for its params, and named
inputs and outputs, each with a contract. A contract has an explicit identity
(such as `asset-subject`, `date` or `raw-prices-eod`) and the schema its
values satisfy. A reference connects only to an input with the same contract
identity; there is no structural subtyping.

`GET /api/step-types` returns the catalog: every step type with its params
JSON Schema and its ports, every contract with its JSON Schema, and the
run-context fields with the contract each provides per scope.

| Step type                        | Scopes           | Inputs                                                                                                                 | Outputs                                                                          |
| -------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `download-prices`                | asset            | `asset` (`asset-subject`), `throughDate` (`date`)                                                                      | `raw` (`raw-prices-eod`)                                                         |
| `normalize-prices`               | asset            | `raw` (`raw-prices-eod`)                                                                                               | `prices` (`prices-eod`)                                                          |
| `publish-dataset`                | asset, portfolio | `data` (`publishable-dataset`)                                                                                         | `publication` (`dataset-publication`)                                            |
| `portfolio-holdings`             | portfolio        | `portfolio` (`portfolio-subject`), `processingDate` (`date`)                                                           | `holdingsDate` (`date`), `holdings` (`holdings`)                                 |
| `wait-for-asset-publications`    | portfolio        | `holdings` (`holdings`), `processingDate` (`date`)                                                                     | `publications` (`published-asset-prices`)                                        |
| `calculate-portfolio-volatility` | portfolio        | `holdings` (`holdings`), `holdingsDate` (`date`), `publications` (`published-asset-prices`), `processingDate` (`date`) | `data` (`portfolio-volatility-data`), `summary` (`portfolio-volatility-summary`) |

`download-prices` requests the asset's prices from its provider, from the
asset's backfill start (or the optional `startDate` param) through
`throughDate`. It stores the validated response as a run artifact and outputs
its reference. See [Workflow runs](/docs/workflows/runs/).
`normalize-prices` and `publish-dataset` turn that into the asset's published
`prices_eod` dataset through the Python service; see
[Python operations and published datasets](/docs/workflows/datasets/).

`portfolio-holdings` reads the saved snapshot effective at the input date
and stores its symbols and weights in a JSON run artifact (`portfolio-holdings/v1`),
along with the portfolio, processing date and effective holdings date. The
`holdings` output is its artifact reference. Bind it to the `holdings` input of
`wait-for-asset-publications`; that step reads the artifact to determine the
required assets and returns a JSON artifact reference (`published-asset-prices/v1`)
containing their matching publication list. The wait's `workflowId` parameter names the required
upstream workflow. Its optional `timeoutSeconds` can shorten the default
two-hour deadline. See [Dependency waits](/docs/workflows/runs/#dependency-waits).

`calculate-portfolio-volatility` reads the holdings and publication-list
artifacts and uses the effective snapshot and the matching published prices to
calculate ex-ante volatility. Pass its `data` output to
`publish-dataset` with `dataset: "portfolio_volatility"`. The `summary` output
shows the volatility, return window and effective holdings date in the run.

## Validation

`POST` and `PUT` reject a malformed body with `400`. A well-formed
specification that does not fit the registry gets `422` with every issue,
each with a `path` into the submitted JSON:

- a step ID used twice, or an unknown step type;
- a step type that does not support the definition's scope;
- params that don't match the step type's schema (including unknown keys);
- a missing binding for a declared input, or a binding for an undeclared one;
- a literal that does not satisfy the input's contract;
- a reference that is malformed, names an unknown context field, an unknown
  step, the step itself, a later step, or an output the step does not have;
- a reference whose contract differs from the input's and is absent from its
  explicit `accepts` list in the catalog.

```json
{
  "error": "The workflow specification is invalid",
  "issues": [
    {
      "path": ["steps", "0", "inputs", "throughDate", "ref"],
      "message": "Input \"throughDate\" expects contract \"date\" but \"context.subject\" provides \"asset-subject\""
    }
  ]
}
```

Validation runs before anything is written, so a rejected `PUT` leaves the
saved definition unchanged.

## Assignments

An assignment links one definition to one existing subject of its scope, at
most once. Assignments can be disabled to pause one subject without changing
the shared definition. A definition's scope can't change while it has
assignments or is a default (`409`); remove them first. Deleting a definition
removes its assignments and its default link. Deleting a definition or
removing an assignment is refused (`409`) while it has an active run; run
history is kept either way.

Each assignment is listed with its definition's schedule (`schedule.hourUtc`)
and enabled state (`workflowEnabled`). `GET /api/workflow-assignments` lists
them across definitions, filtered by `workflowId` or by subject
(`subjectKind` and `subjectId` together): what is scheduled for which
subject.

## Defaults

Defaults are explicit per subject kind. Creating an asset or portfolio assigns
its kind's defaults in the same database batch. A definition can only be a
default for its own scope.

```sh
curl -X PUT "$URL/api/workflow-defaults/asset/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/workflow-defaults" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X DELETE "$URL/api/workflow-defaults/asset/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X POST "$URL/api/workflow-defaults/asset/apply" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

- Adding a default is idempotent. Adding or removing one affects only
  subjects created later; existing subjects keep their assignments.
- Applying the defaults to existing subjects is explicit: `POST
/api/workflow-defaults/<kind>/apply` adds each missing default assignment,
  enabled, and returns them as `added`. It never touches an existing
  assignment, so a deliberately disabled one stays disabled, and applying
  again adds nothing. A removed assignment counts as missing.
- Creating a subject that already exists (`409`) assigns nothing.

## In the app

- **Assets** (`/assets`, `/assets/:symbol`) list assets and the definitions
  assigned to each.
- **Portfolios** (`/portfolios`, `/portfolios/:id`) list portfolios and show
  dated holdings and assigned workflows.
- **Workflows** (`/workflows`, `/workflows/:id`) list definitions and the
  defaults for each subject kind, and show one with its schedule, whether it
  is a default, its assignments and ordered steps: each step's parameters,
  where each input comes from (a literal, the run context, or a link to the
  earlier step), and which later steps use each output.

An asset's page shows each assigned workflow's daily UTC hour.

Both also list recent [runs](/docs/workflows/runs/#in-the-app). These pages
are read-only; change configuration through the API. See
[Management API](/docs/reference/api/#assets) for the routes.
