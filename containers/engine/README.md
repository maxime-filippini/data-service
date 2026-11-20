# Calculation engine

Python container for the data-service Worker ([README](../../README.md)).
It runs calculations, such as ex-ante volatility, over the canonical Parquet
datasets and writes their results next to them in R2. The Worker owns
portfolios, calculations and runs in D1; this service only reads and writes
R2. See [calculations and runs](../../docs/src/content/docs/calculations/runs.md)
and the [maintainer guide](../../docs/src/content/docs/maintaining.md).

The `hypothetical_portfolio_returns` type returns historical constant-weight
returns using the holdings selected at `asOf`. The Worker's synchronous route
resolves mixed saved references/inline holdings into an ordered `portfolios`
batch. The calculation shares a data-reader scope across entries, adds `portfolio_index`,
and returns JSON or Arrow without R2 writes. Any batch error aborts the response;
expected calculation errors retain an indexed 422, and infrastructure errors
retain an indexed 500. See the
[return-history contract](../../docs/src/content/docs/calculations/returns.md).

## Adding a calculation type

Add one module to `src/data_service_engine/types/` that exports
`TYPE = CalculationType(...)`. Its `run(params, ctx)` receives the whole request
and returns a `CalculationResult`. The runtime invokes it once, then either
returns its rows or persists its successful result for a saved run.

The calculation chooses its data helpers and calls them directly:

```python
with market_data(ctx.as_of, ctx.load_symbol) as data:
    for portfolio in ctx.portfolios:
        inputs = load_portfolio_data(portfolio, data)
        rows = calculate_portfolio(params, inputs)
```

- `market_data(as_of, load_symbol=None)` opens date-bounded canonical access.
  `data.load(dataset, symbols, start=None, end=None)` reads requested symbols.
  One scope caches each object once and closes the connection on exit. An
  optional loader supplies local frames for tests.
- `load_portfolio_data(portfolio, data, start=None)` returns `PortfolioData`:
  the calculation-date holdings snapshot, raw price rows and their as-of date.
  Saved IDs are resolved to compositions by the Worker before reaching Python.
- `price_returns(prices, symbols)` aligns already-loaded adjusted prices and
  computes unweighted asset returns. It performs no I/O.

Each type's `run` owns its ordinary loop and `try`/`except` error handling.
`calculate_portfolio` takes prepared data and performs the numerical work.
`portfolio_rows` validates and tags completed rows; `portfolio_result` combines
already-produced frames and outcomes. Neither helper executes a calculation,
loads data or catches errors.

A symbol calculation can load symbols from its parameters and return rows
without a portfolio loop. An aggregate calculation can consume `ctx.portfolios`
and return one result. `takes_portfolio` is catalog/UI metadata; it does not
choose an execution strategy. Output columns are validated and cast, and the
framework adds `as_of`; the type or its chosen helper owns identifying columns.

See [Writing a calculation type](../../docs/src/content/docs/calculations/types.md)
for a complete example, symbol and aggregate variants, and the error contract.
Modules starting with `_` are skipped by discovery. Duplicate registered names
stop the engine from starting.

## Contract

The container is reachable only through the Worker, so there is no
authentication.

| Endpoint                     | Does                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /health`                | Liveness probe.                                                                               |
| `GET /types`                 | Each type's name, description, `takesPortfolio`, params JSON Schema and output columns.       |
| `POST /types/:name/validate` | `{"params": {…}}` → `200 {"params": …}` with defaults filled in, `422` with errors, or `404`. |
| `POST /runs`                 | Runs a saved calculation for one as-of date and writes its rows to R2.                        |
| `POST /calculate`            | Runs an ad hoc calculation and returns its rows. Writes nothing.                              |

### Runs

```json
{
  "runId": "…",
  "type": "ex_ante_vol",
  "params": { "window": 252 },
  "asOf": "2026-10-16",
  "portfolios": [
    {
      "id": "…",
      "name": "Core",
      "snapshots": [
        {
          "holdingsDate": "2026-09-30",
          "holdings": [{ "symbol": "AAPL.US", "weight": 0.6 }]
        }
      ]
    }
  ],
  "outputKey": "calculation=<id>/data.parquet"
}
```

A well-formed request always gets `200`, with what happened:

```json
{
  "status": "partial",
  "error": null,
  "portfolios": [
    { "portfolioId": "…", "status": "completed", "rowCount": 1, "error": null },
    {
      "portfolioId": "…",
      "status": "failed",
      "rowCount": 0,
      "error": "No prices_eod data for X.US"
    }
  ],
  "rowCount": 1,
  "outputEtag": "…"
}
```

- `completed`: every portfolio worked. `partial`: some failed and the others
  were written. `failed`: nothing was written; `error` says why (unknown type,
  invalid params, every portfolio failed, R2 errors).
- The run replaces every row for its as-of date in `outputKey` and keeps the
  other dates, so running a date again is safe. A portfolio that failed loses
  its earlier rows for that date.
- The write is conditional on the object not changing since it was read.
  The Worker still runs one run per calculation at a time.
- New output columns are added to the file, with nulls for older rows.

### Ad hoc

```json
{
  "type": "ex_ante_vol",
  "params": {},
  "asOf": "2026-10-16",
  "portfolio": { "holdings": [{ "symbol": "AAPL.US", "weight": 1 }] }
}
```

Returns `{"rows": [...]}` as JSON (NaN and infinity become `null`), or an
Arrow IPC stream with `Accept: application/vnd.apache.arrow.stream`.
`404` for an unknown type, `422` for invalid params or a missing portfolio,
`500 {"detail": …}` when the calculation fails.

`portfolio` takes `snapshots` like a run, or plain `holdings`, which become
one undated snapshot that counts as held at all times.

The Worker loads each portfolio's snapshots up to the as-of date and checks
that each symbol is tracked before calling the engine. `422` covers malformed
requests: a zero weight, a repeated symbol or holdings date, or a saved run
portfolio without an `id` or with an undated snapshot.

## Configuration

Set these variables in the environment or a local `.env` file:

| Variable               | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `R2_ENDPOINT_URL`      | `https://<account-id>.r2.cloudflarestorage.com`                   |
| `R2_ACCESS_KEY_ID`     | R2 S3 access key                                                  |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret key                                                  |
| `PROCESSED_BUCKET`     | Bucket holding datasets and results, e.g. `processed-market-data` |

The bucket has no default, so a misconfigured deployment fails instead of
touching production data. The credentials need read and write access to it.

## Run locally

```sh
uv sync
uv run pytest                     # on CPUs without AVX: uv run --with 'polars[rtcompat]' pytest
uv run engine types               # list types and their params schemas
uv run engine run request.json    # one run request, prints the result
uv run uvicorn data_service_engine.app:app --port 8080
```

Cloudflare requires a `linux/amd64` image:

```sh
docker build --platform linux/amd64 -t calculation-engine .
```

## Verification

From the repo root, `pnpm engine:test` and `pnpm engine:lint` run the same
checks as CI.
