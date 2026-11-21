---
title: Management API
description: Every management API route, curl examples, and removed pre-workflow endpoints.
---

The management API is served under `/api` at
`https://data-service.maximefilippini.me` (dev:
`https://data-service-dev.maximefilippini.me`), written `$URL` below. Every
route requires:

```txt
Authorization: Bearer $MANAGEMENT_API_TOKEN
```

Cloudflare Access bypasses `/api`, so scripts and client apps use only the
Bearer token. The [app](/docs/operations/dashboard/) mounts the same route
modules under `/app-api/*` behind Cloudflare Access and same-origin mutation
protection.

## Routes

| Method   | Path                                            | Does                                                                         |
| -------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/api/assets`                                   | List assets                                                                  |
| `POST`   | `/api/assets`                                   | Create an asset (`409` if symbol exists)                                     |
| `GET`    | `/api/assets/:symbol`                           | One asset                                                                    |
| `PATCH`  | `/api/assets/:symbol`                           | Update provider, backfill start date or enabled                              |
| `DELETE` | `/api/assets/:symbol`                           | Delete if no holdings or active runs reference it                            |
| `GET`    | `/api/portfolios`                               | List portfolios                                                              |
| `POST`   | `/api/portfolios`                               | Create a portfolio, optionally with its first snapshot                       |
| `GET`    | `/api/portfolios/:id`                           | One portfolio with its dated snapshots                                       |
| `PATCH`  | `/api/portfolios/:id`                           | Rename a portfolio                                                           |
| `DELETE` | `/api/portfolios/:id`                           | Delete if no active workflow runs reference it                               |
| `GET`    | `/api/portfolios/:id/snapshots?from=&through=`  | Effective starting snapshot plus changes through `through`                   |
| `GET`    | `/api/portfolios/:id/snapshots/effective?date=` | Snapshot effective at `date`                                                 |
| `POST`   | `/api/portfolios/:id/snapshots`                 | Add a dated holdings snapshot                                                |
| `DELETE` | `/api/portfolios/:id/snapshots/:holdingsDate`   | Delete a snapshot                                                            |
| `GET`    | `/api/step-types`                               | Step catalog: step types, contracts and run context                          |
| `GET`    | `/api/workflows`                                | List workflow definitions                                                    |
| `POST`   | `/api/workflows`                                | Create a workflow definition from a complete specification                   |
| `GET`    | `/api/workflows/:id`                            | One workflow definition                                                      |
| `PUT`    | `/api/workflows/:id`                            | Atomically replace the complete specification                                |
| `DELETE` | `/api/workflows/:id`                            | Delete definition and its assignments (`409` if active run)                  |
| `GET`    | `/api/workflows/:id/assignments`                | List a definition's assignments                                              |
| `POST`   | `/api/workflows/:id/assignments`                | Assign definition to an asset or portfolio                                   |
| `PATCH`  | `/api/workflows/:id/assignments/:kind/:subject` | Enable or disable one assignment                                             |
| `DELETE` | `/api/workflows/:id/assignments/:kind/:subject` | Remove one assignment (`409` if active run)                                  |
| `GET`    | `/api/workflow-assignments`                     | List assignments with schedules (`?workflowId=`, `?subjectKind=&subjectId=`) |
| `GET`    | `/api/workflow-defaults`                        | Default workflows per subject kind (`?subjectKind=`)                         |
| `PUT`    | `/api/workflow-defaults/:kind/:id`              | Add a default workflow for new subjects of `kind`                            |
| `DELETE` | `/api/workflow-defaults/:kind/:id`              | Remove a default workflow                                                    |
| `POST`   | `/api/workflow-defaults/:kind/apply`            | Idempotently add missing default assignments to existing subjects            |
| `POST`   | `/api/runs`                                     | Start a workflow run (`processingDate` defaults to today UTC)                |
| `GET`    | `/api/runs`                                     | List runs newest first (filters, `?limit=` up to 200)                        |
| `GET`    | `/api/runs/:runId`                              | One run with its captured steps and outcomes                                 |
| `POST`   | `/api/runs/:runId/rerun`                        | Rerun the same assignment and processing date from step 1                    |
| `GET`    | `/api/runs/:runId/steps/:step/artifacts/:name`  | Download a temporary artifact referenced by a step output                    |
| `GET`    | `/api/datasets`                                 | List published datasets (`?subjectKind=`, `?subjectId=`, `?dataset=`)        |
| `GET`    | `/api/datasets/:dataset/:kind/:subject`         | One publication's metadata                                                   |
| `GET`    | `/api/datasets/:dataset/:kind/:subject/data`    | Current published Parquet object (with ETag / `304`)                         |

## Assets

```sh
curl -X POST "$URL/api/assets" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"AAPL.US","provider":"eodhd","backfillStartDate":"2016-01-01"}'

curl "$URL/api/assets" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/assets/AAPL.US" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X PATCH "$URL/api/assets/AAPL.US" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
curl -X DELETE "$URL/api/assets/AAPL.US" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

`enabled` defaults to `true`. Symbols are uppercase with an optional exchange
suffix (`AAPL`, `AAPL.US`, `BRK-B.US`). Creating an asset assigns active asset
defaults and creates no portfolio. Deleting an asset referenced by holdings or
an active run returns `409`.

## Portfolios

```sh
curl -X POST "$URL/api/portfolios" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Core","snapshot":{"holdingsDate":"2026-09-30","holdings":[{"symbol":"AAPL.US","weight":0.6},{"symbol":"MSFT.US","weight":0.4}]}}'

curl "$URL/api/portfolios" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/portfolios/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/portfolios/$ID/snapshots/effective?date=2026-10-10" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/portfolios/$ID/snapshots?from=2026-10-01&through=2026-10-15" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/workflow-assignments?subjectKind=portfolio&subjectId=$ID" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

curl -X PATCH "$URL/api/portfolios/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"Core equity"}'
curl -X DELETE "$URL/api/portfolios/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

curl -X POST "$URL/api/portfolios/$ID/snapshots" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"holdingsDate":"2026-10-15","holdings":[{"symbol":"AAPL.US","weight":1}]}'
curl -X DELETE "$URL/api/portfolios/$ID/snapshots/2026-10-15" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Unknown assets return `400` with `symbols`. Duplicate snapshot dates, edits to
retained legacy single-asset portfolios, or deleting a portfolio with an active
workflow run return `409`. An effective-date query with no applicable snapshot
returns `422`. See [Portfolios](/docs/workflows/portfolios/).

## Workflows, assignments and defaults

```sh
curl "$URL/api/step-types" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

curl -X POST "$URL/api/workflows" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Daily EOD prices","scope":"asset","enabled":true,"schedule":{"hourUtc":4},
       "steps":[
         {"id":"download","type":"download-prices","inputs":{"asset":{"ref":"context.subject"},"throughDate":{"ref":"context.processingDate"}}},
         {"id":"normalize","type":"normalize-prices","inputs":{"raw":{"ref":"steps.download.outputs.raw"}}},
         {"id":"publish","type":"publish-dataset","params":{"dataset":"prices_eod"},"inputs":{"data":{"ref":"steps.normalize.outputs.prices"}}}
       ]}'

curl -X PUT "$URL/api/workflows/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d @definition.json

curl -X POST "$URL/api/workflows/$ID/assignments" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"subject":{"kind":"asset","symbol":"AAPL.US"}}'
curl -X PATCH "$URL/api/workflows/$ID/assignments/asset/AAPL.US" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
curl -X DELETE "$URL/api/workflows/$ID/assignments/asset/AAPL.US" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

curl "$URL/api/workflow-assignments?subjectKind=asset&subjectId=AAPL.US" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X PUT "$URL/api/workflow-defaults/asset/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X POST "$URL/api/workflow-defaults/asset/apply" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Invalid specifications return `422` with `issues`; rejected `PUT` requests
preserve the saved definition. Scope changes while assignments or default links
exist return `409`. See [Assets and workflow definitions](/docs/workflows/definitions/).

## Runs

```sh
curl -X POST "$URL/api/runs" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"'$ID'","subject":{"kind":"asset","symbol":"AAPL.US"}}'

curl "$URL/api/runs?subjectKind=asset&subjectId=AAPL.US&status=failed" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/runs?trigger=schedule&status=skipped" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/runs/$RUN" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X POST "$URL/api/runs/$RUN/rerun" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/runs/$RUN/steps/download/artifacts/raw" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Starting a run returns `202` (`queued`, or `skipped` when the assignment
already has an active run). Disabled definitions, assignments, or assets return
`409`. The app serves the same routes at `/app-api/workflow-runs`. See
[Workflow runs](/docs/workflows/runs/).

## Datasets

```sh
curl "$URL/api/datasets?subjectKind=asset&subjectId=AAPL.US" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/datasets/prices_eod/asset/AAPL.US" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -o AAPL.parquet "$URL/api/datasets/prices_eod/asset/AAPL.US/data" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -o vol.parquet "$URL/api/datasets/portfolio_volatility/portfolio/$PORTFOLIO_ID/data" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Unpublished datasets return `404`. Publications and data remain accessible
after allowed asset, portfolio, or workflow deletion. The app serves the same
routes at `/app-api/publications`. See
[Python operations and published datasets](/docs/workflows/datasets/).

## Breaking removals from the pre-workflow API

The following pre-workflow endpoints were retired once downloads cut over to
workflows and now return `404`:

| Removed route                                                                                                                                                                                                                               | Replacement                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/api/symbols`, `/api/symbols/...`                                                                                                                                                                                                          | `/api/assets` + `/api/workflows/:id/assignments`                                                                  |
| `/api/ingestions`                                                                                                                                                                                                                           | `POST /api/runs` for an asset workflow assignment                                                                 |
| `/api/schedule`, `/api/schedule/runs`                                                                                                                                                                                                       | Daily `schedule.hourUtc` on `/api/workflows` + hourly `scheduledWorkflowTick`                                     |
| `/api/calculation-types`                                                                                                                                                                                                                    | `GET /api/step-types`                                                                                             |
| `/api/calculations`, `/api/calculations/...`                                                                                                                                                                                                | Portfolio `/api/workflows` (`portfolio-holdings` → wait → volatility → publish)                                   |
| `/api/calculate` (synchronous ad hoc)                                                                                                                                                                                                       | Retired deliberately; run a portfolio workflow asynchronously via `POST /api/runs`                                |
| `/app-api/runs`, `/app-api/symbols`, `/app-api/options`, `/app-api/registry`, `/app-api/ingestions`, `/app-api/schedule`, `/app-api/calculation-types`, `/app-api/calculate`, `/app-api/calculations`, `/app-api/datasets/:dataset/:symbol` | `/app-api/assets`, `/app-api/portfolios`, `/app-api/workflows`, `/app-api/workflow-runs`, `/app-api/publications` |
