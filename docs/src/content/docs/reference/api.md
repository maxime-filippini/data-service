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

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/api/symbols` | Register or update a tracked symbol |
| `GET` | `/api/symbols` | List tracked symbols (`?dataset=`, `?enabled=`) |
| `POST` | `/api/symbols/:dataset/:symbol/enable` | Put a symbol on the daily schedule |
| `POST` | `/api/symbols/:dataset/:symbol/disable` | Take a symbol off the daily schedule |
| `POST` | `/api/ingestions` | Download symbols now |
| `GET` | `/api/schedule` | The daily schedule, with its next run time |
| `PATCH` | `/api/schedule` | Change the hour or pause / resume |
| `GET` | `/api/schedule/runs` | Recent schedule runs (`?limit=`, up to 100) |
| `POST` | `/api/schedule/runs` | Run the schedule now |
| `GET` | `/api/portfolios` | List portfolios |
| `POST` | `/api/portfolios` | Create a portfolio, optionally with a snapshot |
| `GET` | `/api/portfolios/:id` | One portfolio with its snapshots |
| `PATCH` | `/api/portfolios/:id` | Rename |
| `DELETE` | `/api/portfolios/:id` | Delete (`409` if a calculation uses it) |
| `POST` | `/api/portfolios/:id/snapshots` | Add a snapshot |
| `DELETE` | `/api/portfolios/:id/snapshots/:holdingsDate` | Delete a snapshot |
| `GET` | `/api/calculation-types` | The engine's types, params schemas and output columns |
| `GET` | `/api/calculations` | List calculations with their latest run |
| `POST` | `/api/calculations` | Create a calculation |
| `GET` | `/api/calculations/:id` | One calculation |
| `PATCH` | `/api/calculations/:id` | Change name, params, portfolios, cron or enabled |
| `DELETE` | `/api/calculations/:id` | Delete it and its runs (results stay in R2) |
| `POST` | `/api/calculations/:id/runs` | Run now (`asOf` optional) |
| `GET` | `/api/calculations/:id/runs` | Its runs, newest first (`?limit=`, up to 100) |
| `GET` | `/api/calculations/:id/runs/:runId` | One run |
| `POST` | `/api/calculate` | Ad hoc calculation; nothing saved |

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
for the same date returns `409`. Deleting a portfolio a calculation uses
returns `409` with those calculations in `calculations`. See
[Portfolios](/docs/calculations/portfolios/).

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
