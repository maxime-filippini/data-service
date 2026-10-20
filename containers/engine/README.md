# Calculation engine

Python container for the data-service Worker ([README](../../README.md)).
It runs calculations, such as ex-ante volatility, over the canonical Parquet
datasets and writes their results next to them in R2. The Worker owns
portfolios, calculations and runs in D1; this service only reads and writes
R2. See [the spec](../../docs/calculation-engine.md).

## Adding a calculation type

Add one module to `src/data_service_engine/types/` that defines
`TYPE = CalculationType(...)`:

```python
class Params(BaseModel):
    model_config = ConfigDict(extra="forbid")
    window: int = Field(252, ge=2)

def run(params: Params, ctx: Context) -> pl.DataFrame:
    snapshot = ctx.portfolio.holdings_at(ctx.as_of)
    prices = ctx.load("prices_eod", snapshot.symbols, start=...)
    return pl.DataFrame({"value": [...]})

TYPE = CalculationType(
    name="my_type",
    description="What it calculates.",
    params=Params,
    output={"value": pl.Float64},
    run=run,
    takes_portfolio=True,
)
```

- `params` is a Pydantic model. `GET /types` publishes its JSON Schema, and
  the Worker stores params as plain JSON.
- `output` lists the columns `run` returns, in order. The framework checks
  them, casts to these types and adds `as_of` and `portfolio_id`. `run` may
  return any number of rows.
- `takes_portfolio=True` runs the type once per portfolio. Otherwise the type
  runs once with `ctx.portfolio` set to `None`.
- `ctx.portfolio` holds every holdings snapshot up to `ctx.as_of`, and the
  type picks what it needs. A snapshot is the holdings at the close of its
  `holdings_date`, in effect until the next one:
  - `holdings_at(day)`: the snapshot in effect at the close of `day`.
  - `snapshots_between(start, end)`: every snapshot in effect at some close
    in the period, starting with the one in effect at `start`.
  - `holdings_frame(start, end)`: the same as `holdings_date`, `symbol`,
    `weight` rows, for joining with prices.
  - `symbols`: every symbol held in any snapshot.

  A portfolio with no snapshot on or before the as-of date fails before the
  type runs.
- `ctx.load(dataset, symbols, start, end)` returns the dataset's rows with a
  `symbol` column. It never returns rows after `ctx.as_of`.
- Raise `CalculationError` for expected failures, like missing data. Its
  message is shown as is; other exceptions show their type too.

Modules starting with `_` are skipped, so shared helpers can live there.
Two types with the same name stop the engine from starting.

## Contract

The container is reachable only through the Worker, so there is no
authentication.

| Endpoint | Does |
| --- | --- |
| `GET /health` | Liveness probe. |
| `GET /types` | Each type's name, description, `takesPortfolio`, params JSON Schema and output columns. |
| `POST /types/:name/validate` | `{"params": {…}}` → `200 {"params": …}` with defaults filled in, `422` with errors, or `404`. |
| `POST /runs` | Runs a saved calculation for one as-of date and writes its rows to R2. |
| `POST /calculate` | Runs an ad hoc calculation and returns its rows. Writes nothing. |

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
        { "holdingsDate": "2026-09-30", "holdings": [{ "symbol": "AAPL.US", "weight": 0.6 }] }
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
    { "portfolioId": "…", "status": "failed", "rowCount": 0, "error": "No prices_eod data for X.US" }
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

| Variable | Purpose |
| --- | --- |
| `R2_ENDPOINT_URL` | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | R2 S3 access key |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret key |
| `PROCESSED_BUCKET` | Bucket holding datasets and results, e.g. `processed-market-data` |

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
