---
title: Management API
description: Every management route, with curl examples.
---

The API is served under `/api` at `https://data-service.maximefilippini.me`
(dev: `https://data-service-dev.maximefilippini.me`), written `$URL`
below. Every route needs:

```txt
Authorization: Bearer $MANAGEMENT_API_TOKEN
```

Cloudflare Access lets `/api` through, so scripts and other apps only need the
token. The [app](/docs/operations/dashboard/) mounts the same route modules
under `/app-api/*` with Cloudflare Access in place of the token.

## Routes

| Method   | Path                                            | Does                                                  |
| -------- | ----------------------------------------------- | ----------------------------------------------------- |
| `POST`   | `/api/symbols`                                  | Register or update a tracked symbol                   |
| `GET`    | `/api/symbols`                                  | List tracked symbols (`?dataset=`, `?enabled=`)       |
| `POST`   | `/api/symbols/:dataset/:symbol/enable`          | Put a symbol on the daily schedule                    |
| `POST`   | `/api/symbols/:dataset/:symbol/disable`         | Take a symbol off the daily schedule                  |
| `POST`   | `/api/ingestions`                               | Download symbols now                                  |
| `GET`    | `/api/schedule`                                 | The daily schedule, with its next run time            |
| `PATCH`  | `/api/schedule`                                 | Change the hour or pause / resume                     |
| `GET`    | `/api/schedule/runs`                            | Recent schedule runs (`?limit=`, up to 100)           |
| `POST`   | `/api/schedule/runs`                            | Run the schedule now                                  |
| `GET`    | `/api/portfolios`                               | List portfolios                                       |
| `POST`   | `/api/portfolios`                               | Create a portfolio, optionally with a snapshot        |
| `GET`    | `/api/portfolios/:id`                           | One portfolio with its snapshots                      |
| `PATCH`  | `/api/portfolios/:id`                           | Rename                                                |
| `DELETE` | `/api/portfolios/:id`                           | Delete (`409` if a calculation uses it)               |
| `POST`   | `/api/portfolios/:id/snapshots`                 | Add a snapshot                                        |
| `DELETE` | `/api/portfolios/:id/snapshots/:holdingsDate`   | Delete a snapshot                                     |
| `GET`    | `/api/calculation-types`                        | The engine's types, params schemas and output columns |
| `GET`    | `/api/calculations`                             | List calculations with their latest run               |
| `POST`   | `/api/calculations`                             | Create a calculation                                  |
| `GET`    | `/api/calculations/:id`                         | One calculation                                       |
| `PATCH`  | `/api/calculations/:id`                         | Change name, params, portfolios, cron or enabled      |
| `DELETE` | `/api/calculations/:id`                         | Delete it and its runs (results stay in R2)           |
| `POST`   | `/api/calculations/:id/runs`                    | Run now (`asOf` optional)                             |
| `GET`    | `/api/calculations/:id/runs`                    | Its runs, newest first (`?limit=`, up to 100)         |
| `GET`    | `/api/calculations/:id/runs/:runId`             | One run                                               |
| `POST`   | `/api/calculate`                                | Ad hoc calculation; nothing saved                     |
| `GET`    | `/api/assets`                                   | List assets                                           |
| `POST`   | `/api/assets`                                   | Create an asset (`409` if the symbol exists)          |
| `GET`    | `/api/assets/:symbol`                           | One asset                                             |
| `PATCH`  | `/api/assets/:symbol`                           | Change provider, backfill start or enabled            |
| `DELETE` | `/api/assets/:symbol`                           | Delete it and its assignments (`409` if a run is on)  |
| `GET`    | `/api/step-types`                               | The step catalog: step types, contracts, run context  |
| `GET`    | `/api/workflows`                                | List workflow definitions                             |
| `POST`   | `/api/workflows`                                | Create a definition from a complete specification     |
| `GET`    | `/api/workflows/:id`                            | One definition                                        |
| `PUT`    | `/api/workflows/:id`                            | Replace the whole specification                       |
| `DELETE` | `/api/workflows/:id`                            | Delete it and its assignments (`409` if a run is on)  |
| `GET`    | `/api/workflows/:id/assignments`                | Its assignments                                       |
| `POST`   | `/api/workflows/:id/assignments`                | Assign it to an asset or portfolio                    |
| `PATCH`  | `/api/workflows/:id/assignments/:kind/:subject` | Enable or disable one assignment                      |
| `DELETE` | `/api/workflows/:id/assignments/:kind/:subject` | Remove one assignment                                 |
| `POST`   | `/api/runs`                                     | Run an assignment now (`processingDate` optional)     |
| `GET`    | `/api/runs`                                     | Runs, newest first (filters, `?limit=` up to 200)     |
| `GET`    | `/api/runs/:runId`                              | One run with its step outcomes                        |
| `POST`   | `/api/runs/:runId/rerun`                        | Run the same assignment and date again                |
| `GET`    | `/api/runs/:runId/steps/:step/artifacts/:name`  | The artifact a step output references                 |
| `GET`    | `/api/datasets`                                 | Dataset publications (subject and dataset filters)    |
| `GET`    | `/api/datasets/:dataset/:kind/:subject`         | One publication's metadata                            |
| `GET`    | `/api/datasets/:dataset/:kind/:subject/data`    | The dataset's current data (Parquet)                  |

## Symbols

Register or update a symbol. Re-registering a disabled symbol enables it:

```sh
curl -X POST "$URL/api/symbols" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dataset":"prices_eod","symbol":"AAPL.US","provider":"eodhd","backfillStartDate":"2016-01-01"}'
```

`enabled` is optional and defaults to `true`. Returns `201` when the symbol is
new and `200` on update. Symbols are uppercase with an optional exchange suffix
(`AAPL`, `AAPL.US`, `BRK-B.US`). The provider must be able to supply the
dataset.

```sh
curl "$URL/api/symbols?dataset=prices_eod&enabled=true" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X POST "$URL/api/symbols/prices_eod/AAPL.US/disable" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X POST "$URL/api/symbols/prices_eod/AAPL.US/enable" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Errors: `400` invalid input, `401` bad token, `404` unknown symbol, `500`
database error.

## Ingestions

```sh
curl -X POST "$URL/api/ingestions" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"entries":[{"dataset":"prices_eod","symbol":"AAPL.US"},{"dataset":"prices_eod","symbol":"MSFT.US"}]}'
```

Returns `202` with the queued entries and the date range each will download
(from the symbol's `backfillStartDate` to the previous UTC day). Up to 500
entries per request; duplicates are ignored. Disabled symbols can still be
ingested manually. If any entry is not registered, or its history starts after
the previous day, the request returns `400` with the `rejected` entries and
queues nothing. See [Ingestion](/docs/pipeline/ingestion/).

## Schedule

```sh
curl "$URL/api/schedule" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X PATCH "$URL/api/schedule" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"hourUtc":6,"paused":false}'
curl "$URL/api/schedule/runs?limit=5" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X POST "$URL/api/schedule/runs" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

See [Daily schedule](/docs/pipeline/schedule/).

## Portfolios

```sh
curl -X POST "$URL/api/portfolios" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Core","snapshot":{"holdingsDate":"2026-09-30","holdings":[{"symbol":"AAPL.US","weight":0.6},{"symbol":"MSFT.US","weight":0.4}]}}'

curl "$URL/api/portfolios" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/portfolios/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

curl -X PATCH "$URL/api/portfolios/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"Core equity"}'
curl -X DELETE "$URL/api/portfolios/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

curl -X POST "$URL/api/portfolios/$ID/snapshots" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"holdingsDate":"2026-10-15","holdings":[{"symbol":"AAPL.US","weight":1}]}'
curl -X DELETE "$URL/api/portfolios/$ID/snapshots/2026-10-15" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Untracked symbols return `400` with their list in `symbols`; a second snapshot
for the same date, or a change to a single-asset portfolio, returns `409`.
Deleting a portfolio a calculation uses returns `409` with those calculations
in `calculations`. See
[Portfolios](/docs/calculations/portfolios/).

## Assets

```sh
curl -X POST "$URL/api/assets" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"AAPL.US","provider":"eodhd","backfillStartDate":"2016-01-01"}'

curl "$URL/api/assets" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X PATCH "$URL/api/assets/AAPL.US" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
curl -X DELETE "$URL/api/assets/AAPL.US" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

`enabled` defaults to `true`. Assets are identified by symbol only and are
separate from the `/api/symbols` registry; creating one creates no portfolio.

## Workflows

```sh
curl "$URL/api/step-types" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

curl -X POST "$URL/api/workflows" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Daily asset prices","scope":"asset","enabled":true,"schedule":{"hourUtc":2},
       "steps":[{"id":"download","type":"download-prices",
                 "inputs":{"asset":{"ref":"context.subject"},"throughDate":{"ref":"context.processingDate"}}}]}'

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
```

A specification that does not fit the step registry returns `422` with every
problem in `issues`; a rejected `PUT` changes nothing. Assigning to a missing
subject or one of the other kind returns `422`, assigning twice `409`, and a
`PUT` that changes the scope while assignments exist `409`. Portfolio
assignments use `{"kind":"portfolio","id":"<uuid>"}` and
`/assignments/portfolio/<uuid>`. See
[Assets and workflow definitions](/docs/workflows/definitions/).

## Runs

```sh
curl -X POST "$URL/api/runs" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"'$ID'","subject":{"kind":"asset","symbol":"AAPL.US"}}'

curl "$URL/api/runs?subjectKind=asset&subjectId=AAPL.US&status=failed" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/runs/$RUN" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -X POST "$URL/api/runs/$RUN/rerun" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/runs/$RUN/steps/download/artifacts/raw" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

Starting a run returns `202` with the run (`queued`, or `skipped` when the
assignment already has an active run). The processing date defaults to
today's UTC date. A disabled definition, assignment or asset returns `409`,
an unknown definition or assignment `404`. Deleting a definition, assignment
or asset while it has an active run returns `409`. The app serves the same
routes at `/app-api/workflow-runs` (its `/app-api/runs` is the legacy
ingestion history). See [Workflow runs](/docs/workflows/runs/).

## Datasets

```sh
curl "$URL/api/datasets?subjectKind=asset&subjectId=AAPL.US" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/datasets/prices_eod/asset/AAPL.US" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl -o AAPL.parquet "$URL/api/datasets/prices_eod/asset/AAPL.US/data" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

A dataset never published for the subject returns `404`. Publications and
data stay after the asset or workflow is deleted. The app serves the same
routes at `/app-api/publications`. See
[Python operations and published datasets](/docs/workflows/datasets/).

## Calculations

```sh
curl "$URL/api/calculation-types" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

curl -X POST "$URL/api/calculations" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Core vol","type":"ex_ante_vol","params":{"window":126},"portfolioIds":["'"$PORTFOLIO_ID"'"],"cron":"0 8 * * 1-5"}'

curl "$URL/api/calculations" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/calculations/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

curl -X PATCH "$URL/api/calculations/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
curl -X DELETE "$URL/api/calculations/$ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"

curl -X POST "$URL/api/calculations/$ID/runs" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"asOf":"2026-10-16"}'
curl "$URL/api/calculations/$ID/runs?limit=10" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
curl "$URL/api/calculations/$ID/runs/$RUN_ID" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

- Invalid params return `422` with the engine's errors in `detail`. A type that
  takes a portfolio needs at least one; other types take none.
- Run now returns `202 {"runId", "status"}` straight away. `status` is
  `skipped` if the calculation already has a run going.
- A run ends `completed`, `partial` (with each portfolio's error in
  `portfolios`) or `failed`.

See [Calculations and runs](/docs/calculations/runs/).

## Ad hoc

```sh
curl -X POST "$URL/api/calculate" \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"ex_ante_vol","params":{},"portfolio":{"holdings":[{"symbol":"AAPL.US","weight":1}]}}'
```

Returns `{"rows": [...]}`, or an Arrow IPC stream with
`Accept: application/vnd.apache.arrow.stream`. Unknown types return `404`;
invalid params and expected failures, such as missing prices, return `422`;
other failures return `500`.
