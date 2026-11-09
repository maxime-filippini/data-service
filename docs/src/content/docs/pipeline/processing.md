---
title: Processing
description: How a raw download becomes the canonical Parquet file.
---

A **processing job** rebuilds one symbol's canonical Parquet file from one
completed ingestion run. Every ingestion run is a full-history snapshot, so
each job rebuilds the file from the latest completed run only. Rebuilds don't
depend on earlier state: retrying or repeating a job is always safe.

## Flow

```mermaid
sequenceDiagram
  autonumber
  participant PQ as Processing queue
  participant W as Processing consumer
  participant D1
  participant C as Processor container
  participant Raw as R2 raw
  participant Out as R2 processed

  PQ->>W: {jobId} (one at a time)
  W->>D1: claim job (queued → processing)
  W->>C: POST /jobs (manifest)
  C->>Raw: GET raw object (If-Match: etag)
  C->>C: check envelope matches manifest,<br/>validate rows, sort by date
  C->>Out: PUT dataset=…/symbol=…/data.parquet
  C-->>W: 200 {outputEtag}
  W->>D1: job completed (output_etag)
  W->>PQ: ack
```

The consumer processes one message at a time (`max_concurrency: 1`,
`max_batch_size: 1`), against a single container instance.

## Job lifecycle

```mermaid
stateDiagram-v2
  [*] --> queued: after ingestion, or daily sweep
  queued --> processing: consumer claims it
  processing --> completed: container 2xx with outputEtag
  processing --> failed: container error response
  processing --> queued: container unreachable<br/>(message retried)
  processing --> failed: stuck over 1h (cron)
  completed --> [*]
  failed --> [*]
```

- **Creating jobs.** The ingestion consumer queues a job right after each run.
  As a fallback, the cron queues a job for each symbol whose latest completed
  run has no job yet, unless the symbol already has an active job.
- **One writer per file.** The unique index `processing_jobs_one_active`
  allows one `queued` or `processing` job per `(dataset, symbol)`.
- **Failures.** A failed job is not retried for the same run. The next
  download creates a new run and a new job.
- **Delivery.** At 02:00 UTC the cron resends every queued job, so a lost
  queue message only delays processing.

## What the processor checks

The processor reads exactly the raw object version in the manifest (`IfMatch`
on its ETag). It checks that the envelope matches the manifest (run, dataset,
symbol, provider, range, row count) and that every row is valid. Then it writes
a date-sorted Parquet file. If a date appears twice, the later row wins.

`prices_eod` columns:

| Column | Type |
| --- | --- |
| `date` | Date |
| `open`, `close`, `high`, `low`, `adjusted_close` | Float64 |
| `volume` | Int64 |

See [Containers](/docs/reference/containers/#processor) for the manifest format.
