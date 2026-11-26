# Workflow specification examples

Companion examples for [the implementation spec](specs/workflow-service.md), not an implemented API. Names of steps and
fields below are illustrative. Explicit input references and separation of
temporary artifacts from published datasets have been agreed.

## Execution model

A definition declares one subject kind, a daily UTC hour, and an ordered list of
steps. Assignments are separate records. Each run receives `subject` and
`processingDate` in its context. The subject is either
`{ "kind": "asset", "symbol": "AAPL.US" }` or
`{ "kind": "portfolio", "id": "portfolio-1" }`.

`params` contains literal, step-specific configuration. `inputs` binds named
inputs using either `{ "value": ... }` or `{ "ref": ... }`. References name run
context or outputs of earlier steps; they are not expressions. These references
form a DAG whose execution order is the supplied list. Unique step IDs and strictly
backward references prevent cycles without a separate graph scheduling algorithm.
Each registered step declares schemas for params, resolved inputs, and outputs, and compatible
subject kinds. Validation rejects unknown steps, invalid parameters, forward
references, and incompatible bindings. Resolved inputs and returned outputs are
also validated at execution time.

Steps may return small JSON values directly as durable checkpoint outputs.
Steps producing large datasets return artifact references instead of dataset contents. An artifact
reference is an opaque ID plus format/schema metadata; the storage adapter resolves
it to an R2 object or a local fixture/output file. Publication associates an artifact
with a dataset name and subject. The public dataset lookup returns its current
publication. Run metadata can retain artifact references without guaranteeing
their retention or historical reproducibility.

## Asset example

```json
{
  "name": "Daily asset prices",
  "scope": "asset",
  "schedule": { "hourUtc": 2 },
  "steps": [
    {
      "id": "download",
      "type": "download-prices",
      "params": { "provider": "eodhd", "startDate": "2000-01-01" },
      "inputs": {
        "asset": { "ref": "context.subject" },
        "throughDate": { "ref": "context.processingDate" }
      }
    },
    {
      "id": "normalize",
      "type": "normalize-prices",
      "params": {},
      "inputs": { "raw": { "ref": "steps.download.outputs.raw" } }
    },
    {
      "id": "publish",
      "type": "publish-dataset",
      "params": { "dataset": "prices_eod" },
      "inputs": {
        "subject": { "ref": "context.subject" },
        "artifact": { "ref": "steps.normalize.outputs.prices" },
        "processingDate": { "ref": "context.processingDate" }
      }
    }
  ]
}
```

`download-prices` runs in Effect and writes raw data. `normalize-prices` calls
the Python operation and returns a Parquet artifact. `publish-dataset` exposes
that artifact as the asset's current `prices_eod` dataset and records successful
publication for the processing date. It does not expose raw bucket/key choices
as business configuration. Stable existing R2 consumer paths must be considered
when implementing publication.

## Portfolio example

```json
{
  "name": "Daily portfolio volatility",
  "scope": "portfolio",
  "schedule": { "hourUtc": 6 },
  "steps": [
    {
      "id": "holdings",
      "type": "load-portfolio-holdings",
      "params": { "selection": "effective-at-date" },
      "inputs": {
        "portfolio": { "ref": "context.subject" },
        "throughDate": { "ref": "context.processingDate" }
      }
    },
    {
      "id": "prices",
      "type": "require-asset-datasets",
      "params": {
        "dataset": "prices_eod",
        "upstreamWorkflowId": "asset-prices-workflow-id",
        "waitTimeoutMinutes": 120
      },
      "inputs": {
        "holdings": { "ref": "steps.holdings.outputs.holdings" },
        "processingDate": { "ref": "context.processingDate" }
      }
    },
    {
      "id": "calculate",
      "type": "ex-ante-volatility",
      "params": { "window": 252, "annualisation": 252 },
      "inputs": {
        "holdings": { "ref": "steps.holdings.outputs.holdings" },
        "prices": { "ref": "steps.prices.outputs.datasets" },
        "throughDate": { "ref": "context.processingDate" }
      }
    },
    {
      "id": "publish",
      "type": "publish-dataset",
      "params": { "dataset": "portfolio_volatility" },
      "inputs": {
        "subject": { "ref": "context.subject" },
        "artifact": { "ref": "steps.calculate.outputs.volatility" },
        "processingDate": { "ref": "context.processingDate" }
      }
    }
  ]
}
```

For this volatility example, the holdings step reads the current portfolio
configuration and returns the snapshot effective at the processing date and its
asset list. The existing volatility calculation applies these weights to historical
returns. Operations needing changing holdings over an interval can select the
starting snapshot plus subsequent snapshots; that is a different selection mode.
This is ordinary step data, not a historical portfolio-versioning system.

The dependency step waits for successful upstream runs and matching publications
for those assets and the requested processing date. It returns a list mapping
asset subjects to dataset artifact references. It never starts upstream work.
Timeout fails this portfolio run. Success proves processing/publication, not
independent market-data completeness. The calculation uses the supplied inputs
instead of secretly looking up other datasets. Its numerical convention must
match the selected Python operation; this example preserves the baseline volatility mathematics.

## Publication and local execution

Both examples use the same publication contract: dataset name, subject, artifact,
and processing date. The resulting dataset descriptor contains that identity and
artifact reference. Published data occupies a separate storage prefix and must not
depend on an expiring run artifact. Exclusive writer enforcement is excluded.

Temporary run artifacts expire through an R2 lifecycle rule scoped to their
prefix, after 30 days based on object age rather than run completion. There is no D1 cleanup
index, cleanup manifest, or scheduled cleanup workflow. The retention duration
is configurable and should comfortably exceed expected waits and retries;
R2 expiration does not check whether a run remains active. Published datasets and
existing retained raw history are outside this temporary-artifact rule.

A local runner supplies fixture-backed download, local artifact storage, local
portfolio records through adapters. Running the asset workflows first produces
the real publication and success records consumed by the portfolio dependency step. It executes
the same registered steps and Python operations and writes inspectable outputs.
Tests of Cloudflare durability remain separate from this local demonstration.

The read-only app view renders the ordered steps, input/output references, status,
errors, and published datasets from these same specifications and run records.
