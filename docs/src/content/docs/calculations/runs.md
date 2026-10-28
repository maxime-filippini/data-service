---
title: Calculations and runs
description: Saved calculations, how a run executes, and ad hoc calculations.
---

A **calculation** is a saved configuration:

- a calculation type (fixed once created; create a new calculation instead);
- params (JSON, validated by the engine, stored with defaults filled in);
- a list of portfolio IDs, for types that take a portfolio;
- a cron expression (UTC);
- an enabled flag.

Params, portfolios and cron can change. Earlier results are not rewritten, and
each run saves the params it used.

## Creating one

The Worker knows no calculation types. It asks the engine for them and lets
the engine validate params:

```mermaid
sequenceDiagram
  participant C as Caller
  participant W as Worker
  participant E as Engine container
  participant D1

  C->>W: POST /calculations {type, params, portfolioIds, cron}
  W->>E: POST /types/:type/validate {params}
  alt unknown type
    E-->>W: 404
    W-->>C: 404
  else invalid params
    E-->>W: 422 errors
    W-->>C: 422 {detail}
  else valid
    E-->>W: 200 {params with defaults}
    W->>D1: insert calculations + calculation_portfolios
    W-->>C: 201
  end
```

## How a run executes

A run is one execution for one **as-of date**. Each run is a
`CalculationRunWorkflow` instance whose ID is the run ID.

```mermaid
sequenceDiagram
  autonumber
  participant T as Cron tick or<br/>POST /calculations/:id/runs
  participant W as Worker
  participant D1
  participant WF as CalculationRunWorkflow
  participant E as Engine container
  participant R2 as R2 processed

  T->>W: start run (asOf)
  W->>D1: fail stopped runs for this calculation
  W->>D1: insert calculation_runs (running)
  alt another run is running
    D1-->>W: unique index conflict
    W->>D1: record run as skipped
    W-->>T: 202 {runId, status: skipped}
  else
    W->>WF: create instance id = runId
    W-->>T: 202 {runId, status: running}
    WF->>D1: load each portfolio's snapshots ≤ asOf
    Note over WF: portfolios with no snapshot<br/>fail here, without the engine
    WF->>E: POST /runs (one step, 2 retries, 30 min timeout)
    loop each portfolio
      E->>R2: ctx.load(prices_eod, …)
      E->>E: type.run(params, ctx)
    end
    E->>R2: replace asOf rows in calculation=<id>/data.parquet<br/>(conditional write)
    E-->>WF: {status, portfolios[], rowCount, outputEtag}
    WF->>D1: save outcome on the run
  end
```

### Why a Workflow, not a queue

A Workflow step has no wall-clock limit, while a queue consumer has 15
minutes, and engine runs can be long. One instance per run is also
addressable by run ID, so the Worker can check whether a run is still alive.
The engine step can retry safely because a run replaces its as-of date's rows.

### Run states

```mermaid
stateDiagram-v2
  [*] --> running
  [*] --> skipped: another run is going
  running --> completed: every portfolio worked
  running --> partial: some portfolios failed
  running --> failed: nothing written
  running --> failed: Workflow stopped or never started<br/>(checked after 5 min)
  completed --> [*]
  partial --> [*]
  failed --> [*]
  skipped --> [*]
```

- **One at a time.** The partial unique index `calculation_runs_one_running`
  allows one `running` run per calculation. A run started meanwhile is
  recorded as `skipped`.
- **Several portfolios.** A type that takes a portfolio runs once per
  portfolio. If one fails, the others still complete and the run is `partial`,
  with an error for each portfolio that failed.
- **Stuck runs.** A run `running` for over 5 minutes is checked against its
  Workflow. If the Workflow has errored, been terminated, finished without
  recording, or never started, the run is marked failed. This happens on every
  hourly tick and before each new run of the calculation, so a crash can't
  block later runs.

## Results

Each calculation has one Parquet file:

```txt
processed-market-data/calculation=<calculation-id>/data.parquet
```

It holds the type's output columns plus `as_of` and `portfolio_id`, so it
builds a history over time. A run replaces its own as-of date's rows, so
running the same date again is safe. New output columns are added with nulls
for older rows. Results stay in R2 after the calculation is deleted.

```mermaid
flowchart LR
  r1["run as of 10-14"] --> f
  r2["run as of 10-15"] --> f
  r3["re-run as of 10-15"] -- replaces 10-15 rows --> f
  f[("calculation=&lt;id&gt;/data.parquet<br/>as_of · portfolio_id · outputs…")]
  f --> apps[Client apps]
  f --> exp[Dashboard explorer]
```

## Ad hoc calculations

`POST /calculate` runs a type once and returns the result without saving
anything, with a timeout of about 60 seconds.

```mermaid
sequenceDiagram
  participant C as Caller
  participant W as Worker
  participant D1
  participant E as Engine container

  C->>W: POST /calculate {type, params, asOf?, portfolio}
  opt portfolio = {portfolioId}
    W->>D1: load snapshots ≤ asOf
  end
  W->>E: POST /calculate
  E-->>W: rows (JSON or Arrow IPC)
  W-->>C: {rows: [...]} or Arrow stream
```

`portfolio` is a saved portfolio (`{"portfolioId": …}`) or plain
`{"holdings": [...]}`, which count as held at all times, so other apps can
calculate for portfolios the service doesn't store. `asOf` defaults to the
previous UTC day. Send `Accept: application/vnd.apache.arrow.stream` for Arrow.

| Status | When |
| --- | --- |
| `200` | Rows returned |
| `404` | Unknown type |
| `422` | Invalid params, or an expected failure such as missing prices |
| `500` | Any other failure |
