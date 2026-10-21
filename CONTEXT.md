# Glossary

## Dataset

A kind of data with its own Parquet schema, such as `prices_eod` (daily
prices). Future datasets (for example interest-rate series from FRED) get
their own name and schema.

## Tracked symbol

One `(dataset, symbol)` pair in the download universe, with the provider that
supplies it and the date its history starts. An enabled symbol is on the daily
schedule. Disabling takes it off the schedule but keeps history and the Parquet
object; it can still be downloaded manually.

## Daily schedule

The single schedule that downloads every enabled symbol once a day, after a
chosen UTC hour. It can be paused.

## Schedule run

One run of the daily schedule, started by the cron (at most once a day) or by
hand. It queues an ingestion run for every enabled symbol.

## Ingestion run

One download of a symbol's full history from its provider. The validated
response is stored once as an immutable raw object in R2.

## Processing job

A rebuild of one symbol's canonical Parquet object from one completed
ingestion run. Only one job per symbol can be queued or processing at a time.

## Canonical dataset

The current Parquet object for a `(dataset, symbol)` pair, at the stable key
`dataset=<dataset>/symbol=<symbol>/data.parquet` in the processed bucket.
Client apps read it directly from R2.

## Calculation type

A kind of calculation, such as `ex_ante_vol`. Each one is a Python module in
the engine container with its own params and output columns. See
[the calculation engine spec](docs/calculation-engine.md).

## Portfolio

A name and a series of holdings snapshots. Every symbol must be tracked in
`prices_eod`.

## Holdings snapshot

A portfolio's holdings, a list of `(symbol, weight)`, at the close of a
holdings date. It stays in effect until the portfolio's next snapshot.
Snapshots are added or deleted, never edited. Each calculation type decides
which snapshots it uses.

## Calculation

A saved calculation type with its params, the portfolios it runs over, a cron
expression and an enabled flag. Its results are one Parquet file at
`calculation=<id>/data.parquet` in the processed bucket.

## Calculation run

One run of a calculation for one as-of date, started by its cron or by hand.
The type runs once per portfolio, and the run saves the params it used. It
ends `completed`, `partial` (some portfolios failed) or `failed`. A run started
while another is going is recorded as `skipped`.

## Cron slot

An hour a calculation's cron expression fires in. The hourly tick runs each
calculation once for its most recent slot, so missed slots are caught up once,
not replayed.

## Ad hoc calculation

A calculation type run once through `POST /calculate`, for a saved portfolio
or plain holdings. The result is returned and nothing is saved.
