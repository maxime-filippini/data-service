# Glossary

## Dataset

A kind of data with its own Parquet schema, such as `prices_eod` (daily
prices). Future datasets (for example interest-rate series from FRED) get
their own name and schema.

## Tracked symbol

One `(dataset, symbol)` pair in the download universe, with the provider that
supplies it and the date its history starts. Disabling stops scheduled
downloads but keeps history and the Parquet object.

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
