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
