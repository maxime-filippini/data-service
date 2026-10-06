# Market-data architecture

This document is the handoff for the Python processor. It describes the
current control-plane contract and the intended end-to-end data flow.

## Purpose

The system separates immutable provider inputs from the mutable,
calculation-ready dataset used by downstream engines:

```txt
provider response → raw R2 object → processing job → Python processor
                → canonical Parquet object → calculation clients
```

The Worker owns coordination and metadata. The Python processor owns data
transformation and Parquet production.

## Ubiquitous language

The concise definitions are in [CONTEXT.md](CONTEXT.md). In particular,
do not conflate an **ingestion run** with a **processing job**:

- An ingestion run obtains raw data for one symbol and date range.
- A processing job selects one or more completed ingestion runs and is the
  unit that a Python processor claims and executes.

## Responsibilities

| Part | Responsibilities | Does not do |
| --- | --- | --- |
| Worker | Create and record ingestion runs, store raw objects, create/freeze processing jobs, expose processing-job state transitions, and later publish job IDs to a queue. | Transform rows into Parquet or run expensive calculations. |
| D1 control plane | Record run/job state, immutable input membership, canonical-dataset revision metadata, and applied-run history. | Store market-data payloads or Parquet files. |
| Raw R2 bucket | Retain immutable, validated provider responses. | Serve the canonical calculation dataset. |
| Python processor | Claim a job, read its frozen raw inputs, normalize and merge/rebuild data, write canonical Parquet, then complete or fail the job. | Discover work by listing R2 or decide which ingestion runs belong to a job. |
| Processed R2 bucket | Hold one replaceable canonical Parquet dataset per symbol. | Retain the audit history of provider responses. |
| Calculation clients | Read canonical Parquet. | Read D1 or reconstruct data from raw objects. |

## Storage contracts

### Raw market data

Bucket: `raw-market-data`

Raw data is append-only from the application's perspective. One ingestion
run writes one response envelope at:

```txt
provider=<provider>/symbol=<symbol>/run=<run-id>/response.json
```

The current JSON envelope contains:

```json
{
  "version": 1,
  "runId": "...",
  "provider": "eodhd",
  "symbol": "AAPL.US",
  "requestedRange": { "from": "2024-01-01", "to": "2024-01-31" },
  "receivedAt": "...",
  "entries": []
}
```

D1 records the raw object's key, ETag, observed range, and row count. The
processor must use the exact object references returned by its processing job;
it must not infer inputs from an R2 listing.

### Canonical processed data

Bucket: `processed-market-data`

Each symbol has one stable, replaceable Parquet object:

```txt
dataset=prices_eod/symbol=<symbol>/data.parquet
```

This is the object calculation clients consume. Its ETag and revision are
recorded in D1 after a successful processing job. There is deliberately no
processed JSON cache to treat as the calculation source of truth.

## Lifecycle

### 1. Ingest raw data

An ingestion mechanism—manual for now, scheduled later—creates an ingestion
run for one symbol and date range.

```txt
fetching
  ├─ provider response validated and raw object stored → raw_complete
  └─ provider/storage failure                         → failed
```

Only `raw_complete` runs are eligible for processing.

### 2. Freeze a processing job

Creating a processing job selects eligible `raw_complete` runs and records
their ordered membership in D1. That selection is immutable for the lifetime
of the job; ingestion that finishes afterwards belongs to a later job.

```txt
POST /processing-jobs
  → queued processing job with its own job ID
```

Modes:

- `merge`: select completed runs not yet applied to the canonical dataset.
- `rebuild`: select every completed run for the symbol.

Only one `queued` or `processing` job may exist for a symbol. This protects a
symbol's single canonical object from concurrent writers.

### 3. Claim and process

The processor receives a specific **processing job ID**. At present this is a
manual handoff. Later, job creation should publish `{ "jobId": "..." }` to a
queue; the queue consumer runs the same processor command.

```txt
queued --claim--> processing --complete--> completed
                         └----fail------> failed
```

Claiming is not queue publication and does not discover work. It is an atomic
ownership transition from `queued` to `processing`. A competing processor
cannot claim the same job. The claim response supplies the frozen manifest;
the processor should claim before doing any R2 work.

### 4. Complete or fail

After writing the canonical Parquet object, the processor reports its output
ETag and optional `completeThrough` date. D1 then:

1. records the new canonical ETag and increments its revision;
2. records the selected runs as applied at that revision;
3. marks the job `completed`; and
4. releases the symbol's active-job lock.

On a processing failure, the processor reports a concise error message. D1
marks the job `failed` and releases the lock. Its raw runs remain available for
a later job.

There is no lease or automatic recovery policy for a processor that crashes
after claiming a job. Such a job remains `processing`; adding timeout/retry
recovery is a future control-plane enhancement.

## Processing-job HTTP contract

All routes require:

```http
Authorization: Bearer <PROCESSING_API_TOKEN>
```

| Request | Meaning | Expected outcome |
| --- | --- | --- |
| `POST /processing-jobs` with `{ symbol, mode, transformVersion }` | Freeze eligible ingestion runs into a job. | `201` plus the queued job, or `409` if no work/an active job prevents creation. |
| `GET /processing-jobs/:jobId` | Read a job and its frozen input manifest. | `200` or `404`. |
| `POST /processing-jobs/:jobId/claim` | Take ownership of a queued job. | `200` with status `processing`, or `409` when not claimable. |
| `POST /processing-jobs/:jobId/complete` with `{ outputEtag, completeThrough? }` | Commit successful processing metadata. | `200` with status `completed`. |
| `POST /processing-jobs/:jobId/fail` with `{ message }` | Record terminal processing failure. | `200` with status `failed`. |

The manifest contains the canonical target key, optional expected canonical
ETag for merge mode, transform version, and ordered ingestion runs. Each run
contains the raw object keys and ETags the processor must consume.

## Python processor contract

The first processor should be a one-shot command:

```txt
processor --job-id <processing-job-id>
```

Its algorithm is:

1. Call `POST /processing-jobs/:jobId/claim`.
2. Validate the returned status is `processing`; retain its manifest.
3. Read only the referenced raw R2 objects.
4. Validate/normalize their entries and resolve duplicate-date precedence from
   the manifest order.
5. For `rebuild`, construct the dataset solely from the frozen raw inputs.
   For `merge`, read the canonical Parquet input when present and incorporate
   the frozen new raw inputs.
6. Write the complete replacement Parquet file to the canonical key in
   `processed-market-data`.
7. Call `complete` with the resulting R2 ETag. If any step after claim fails,
   call `fail` with an operational error message.

The processor needs two credential classes:

- `PROCESSING_API_TOKEN` for the Worker control-plane API;
- least-privilege R2 S3 credentials: read `raw-market-data`, write
  `processed-market-data` (and read processed data for merge mode).

Do not give the processor authority to modify D1 directly. Do not make it
derive job membership from bucket listings.

## Current and planned delivery

| Capability | State |
| --- | --- |
| Raw and processed R2 buckets | Provisioned. |
| D1 control-plane schema | Defined in `migrations/0001_initial_market_data_control_plane.sql`; apply it before using the API. |
| Processing-job HTTP routes | Implemented in the Worker branch; deploy with `PROCESSING_API_TOKEN` configured. |
| Scheduled ingestion / ingestion HTTP route | Not implemented. |
| Python processor | Not implemented. |
| Queue publication and consumption | Not implemented. |
| Claim lease / recovery | Not implemented. |

## Local end-to-end test shape

1. Apply the local D1 migration and run the Worker locally with a local
   `PROCESSING_API_TOKEN`.
2. Seed or create one `raw_complete` ingestion run with a raw-object record.
3. Create a processing job through the Worker API.
4. Run the Python command with the returned job ID.
5. Assert the canonical Parquet object exists and the job is `completed`.

This is the first integration test to build in the Python processor project.
