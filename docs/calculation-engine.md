# Calculation engine (spec, being built)

The service only serves provider data today. The calculation engine adds
calculations on top of that data, for example ex-ante volatility for a
portfolio. Calculations run on a schedule or on demand, and their results are
stored next to the market data.

The goal is that **adding a calculation type is one Python file**. The
Worker, D1 and the dashboard don't know about individual types.

Glossary: [CONTEXT.md](../CONTEXT.md).

```txt
hourly cron ──────────────┐
POST /calculations/:id/runs ┴→ calculation run (D1) → Worker → engine container
   → per portfolio: type.run(params, ctx) → calculation Parquet in R2
   → run completed / partial / failed (D1)

POST /calculate (ad hoc) → Worker → engine container → result in the response
```

## Parts

| Part | Role |
| --- | --- |
| Engine container (`containers/engine`) | A Python image separate from the processor, with its own heavier libraries. Holds every calculation type, validates params, runs calculations and writes results to R2. No D1 access. |
| Worker | Stores portfolios, calculations and runs in D1, checks cron expressions on the hourly tick, and drives the engine. Treats params as plain JSON. |
| D1 | `portfolios`, `calculations`, `calculation_runs`. No results. |
| `processed-market-data` (R2) | Calculation results, next to the canonical datasets. |
| Dashboard | Pages for portfolios, calculations and runs. Results open in the existing explorer. |

## Calculation types

A calculation type is one Python module in the engine that registers:

- `name`, for example `ex_ante_vol`;
- a Pydantic `Params` model;
- an output schema (the columns of its result table);
- whether it takes a portfolio;
- `run(params, ctx) -> table`.

How to write one: [the engine README](../containers/engine/README.md).

The engine serves `GET /types`, which returns each type's name and the JSON
Schema of its params. The Worker doesn't know any types. It asks the engine to
validate params and stores them as plain JSON. A new type needs no TypeScript,
migration or dashboard changes, just a new module and a redeploy.

If a type is removed from the code, calculations that use it still exist, but
their runs fail.

### What a type gets

The framework passes a `ctx`:

- `ctx.load(dataset, symbols, start, end)` returns a polars DataFrame read from
  the canonical Parquet files in R2.
- `ctx.as_of` is the date being calculated.
- `ctx.portfolio` is the portfolio being calculated, with its holdings already
  resolved.

Types never call R2 or providers directly. In v1 they can only read datasets,
not other calculations' results.

## Portfolios

A portfolio is a name and a list of `(symbol, weight)`. It has no dataset;
a type that needs prices loads `prices_eod`.

- **Checks.** Every symbol must be a tracked symbol in `prices_eod`. Weights
  are any non-zero numbers (shorts and leverage are allowed, and they don't
  need to sum to 1). Each type normalises or checks them as it needs.
- **Changes.** A portfolio only holds its current holdings, with no history.
  Each run saves the holdings it used, so earlier results stay explainable.
- **Deleting.** Deleting a portfolio that a calculation uses returns `409` with
  the calculations that use it. So does deleting a tracked symbol that a
  portfolio holds. Disabling a symbol is allowed: its Parquet file stays, so
  calculations keep working on its old data.

## Calculations

A calculation is a saved configuration:

- a calculation type (it can't be changed later; create a new calculation
  instead);
- params (JSON, validated by the engine);
- a list of portfolio IDs, for types that take a portfolio;
- a cron expression;
- an enabled flag.

Params, portfolios and cron can be changed. Earlier results are not
rewritten, and each run saves the params it used.

### Several portfolios

A type that takes a portfolio says so when it registers, so its params never
hold portfolios. The calculation lists several portfolios, and the framework runs the type once
per portfolio, so a type only ever handles one. If one portfolio fails, the
others still complete and the run is marked `partial`, with an error for each
portfolio that failed.

## Results

Each calculation has one Parquet file:

```txt
processed-market-data/calculation=<calculation-id>/data.parquet
```

It holds the type's output columns plus `as_of` and `portfolio_id`, so it
builds a history over time. A run replaces its own as-of date's rows, so
running the same as-of date again is safe. Apps read the file from R2 as they
do datasets, and the dashboard explorer shows it unchanged.

## Scheduling

- **Cron.** Each calculation has a standard 5-field cron expression in UTC. The
  existing hourly cron checks them, so the minute field has no effect and the
  finest resolution is one hour. Monthly calculations are just a cron
  expression.
- **Missed slots.** A missed slot is caught up once on the next tick, not
  replayed.
- **As-of date.** A scheduled run calculates as of the previous UTC day, using
  whatever canonical data exists at that time. It doesn't wait for that day's
  downloads, so schedule calculations a few hours after the download hour.
- **One run at a time.** If a calculation already has a run going, a new one
  (from cron or "run now") is skipped and recorded as skipped.

## On demand

- **Run now.** `POST /calculations/:id/runs` starts a run of a saved
  calculation and returns its run ID straight away. It takes an optional
  `asOf` date, which is how you fill in a past date. It writes results to R2
  like a scheduled run.
- **Ad hoc.** `POST /calculate` takes a type, params and a portfolio, runs it
  and returns the result in the response (JSON or Arrow), with a timeout of
  about 60 seconds. Nothing is saved. The portfolio is either
  `{ "portfolioId": … }` or `{ "holdings": [ … ] }`, so other apps can
  calculate for portfolios the service doesn't store. Saved calculations only
  take portfolio IDs.

Both use the management token, or Cloudflare Access through the dashboard.

## Dashboard

- **Portfolios.** List, create, edit, delete.
- **Calculations.** List, create, edit (a JSON editor for params, checked by
  the engine), cron, enable or pause, run now with an optional as-of date.
- **Runs.** Status, the params and holdings used, and errors for each
  portfolio.
- **Results.** Opened in the existing dataset explorer.

## Left out of v1

- Portfolios with history (holdings with effective dates).
- Calculations that read other calculations' results.
- Backfilling a range of as-of dates in one request.
- A params form built from the JSON Schema.
- Starting calculations when the day's downloads have finished.
