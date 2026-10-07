# Market-data glossary

## Ingestion run

One attempt to obtain raw market data for one symbol and requested date range.
It is not the unit of Python processing.

## Raw object

The immutable validated provider response produced by an ingestion run. A raw
object is an auditable input and may be used in more than one processing job.

## Processing job

A request to produce or update one symbol's canonical dataset from a frozen
selection of completed ingestion runs. A processing job is the unit assigned
to a processor.

## Claim

The atomic transition by which a processor takes ownership of a queued
processing job. A claimed job is processing.

## Canonical dataset

The current replaceable, calculation-ready dataset for one symbol. It is
stored as Parquet and has a stable object key.

## Merge

Processing mode that applies ingestion runs not yet represented in the
canonical dataset.

## Rebuild

Processing mode that recreates the canonical dataset from every completed
ingestion run for the symbol.
