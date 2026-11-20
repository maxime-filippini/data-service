---
title: Maintaining the code
description: "Ownership guide: reading path, Effect conventions, failure recovery, extending steps and Python operations, and the local development loop."
---

Start here when returning to the project. Read [Concepts](/docs/concepts/) for
the domain vocabulary and [Architecture](/docs/architecture/) for the Cloudflare
resources. This guide maps every part of the service to the source code and
shows how to run, debug, and extend it locally.

The published docs under `docs/src/content/docs/` are the current reference and
`CONTEXT.md` is the short domain glossary. Files under `.agent/` are historical
design notes.

## The shape of the repository

There is one execution model across the whole service:

```text
Configure asset / portfolio + workflow definition + assignments (D1)
  → Manual submit or hourly scheduledWorkflowTick (atomic claim + Workflow launch)
  → DefinitionRunWorkflow executes captured steps sequentially:
      Effect steps (download, holdings, durable dependency wait, publish)
      + Python HTTP operations (normalize-prices-eod, calculate-portfolio-volatility)
  → Temporary artifacts in raw R2 (runs/, 30-day lifecycle expiry)
  → Explicit publication to processed R2 + D1 dataset_publications metadata
```

The Worker owns all D1 state transitions and durable workflow orchestration.
The single Python service (`containers/engine/`) runs stateless operations over
R2 objects (or local files) and returns small JSON outputs or artifact
references. The SvelteKit app reads page data on the server through `src/pages/`
and sends mutations through `/app-api/*`, which mounts the same route modules as
`/api/*`.

| Location                         | Read it for                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                   | Worker `fetch` and `scheduled` handlers, Workflow & Container exports                                    |
| `src/scheduled.ts`               | Hourly cron wrapper around `scheduledWorkflowTick`                                                       |
| `src/dependencies.ts`            | Concrete Cloudflare adapter wiring shared by routes and page reads                                       |
| `src/routes/`                    | Authentication, request validation, `/api/*` and `/app-api/*` routes                                     |
| `src/http/run-effect.ts`         | Shared Effect execution and expected-error HTTP status mapping                                           |
| `src/assets/`                    | Asset contracts, store interface and D1 adapter (with holdings guards)                                   |
| `src/portfolios/`                | Portfolio and dated snapshot contracts, store interface and D1 adapter                                   |
| `src/workflows/`                 | Definition validation, inspection, assignments, defaults, D1 store                                       |
| `src/workflows/registry/`        | Registered step types, contracts, retry policies and implementations                                     |
| `src/workflows/runs/`            | Atomic claims, launch reconciliation, daily dispatch and run D1 store                                    |
| `src/workflows/executor.ts`      | Sequential step runner, reference resolution, durable dependency waits                                   |
| `src/workflows/steps.ts`         | Narrow adapter over Cloudflare `WorkflowStep`                                                            |
| `src/definition-run-workflow.ts` | Cloudflare Workflow entrypoint wiring production adapters                                                |
| `src/datasets/`                  | Explicit publication step logic, D1 metadata store and R2 adapter                                        |
| `src/operations/`                | Generated TypeScript contracts (`schemas.json`, `contracts.generated.ts`) and Python HTTP client         |
| `src/market-data/`               | Shared schemas (`MarketDateSchema`, `MarketSymbolSchema`, `EodEntrySchema`) and EODHD adapter            |
| `src/local/`                     | Local SQLite D1, file/memory artifact & dataset stores, `uv` Python runner, in-process Workflow stand-in |
| `src/pages/`                     | Read-only page-data facade for SvelteKit server loads                                                    |
| `containers/engine/`             | Uniform Python FastAPI service (`/health`, `/operations`, `/operations/{name}`)                          |
| `app/src/`                       | SvelteKit pages, server loads, and browser API helpers                                                   |
| `migrations/`                    | D1 schema migrations (`0001`–`0014`)                                                                     |
| `scripts/workflow-fixture.ts`    | End-to-end local fixture scenario (`pnpm workflow:fixture`)                                              |
| `test/`                          | API, fixture, real-SQLite D1, contract and lifecycle tests                                               |

### File roles inside a feature

| File            | Responsibility                                                                   |
| --------------- | -------------------------------------------------------------------------------- |
| `contracts.ts`  | Effect Schemas for inputs, outputs, domain types and typed tagged errors         |
| `store.ts`      | Injectable `Context.Service` persistence interface                               |
| `d1.ts`         | SQL and row-to-domain mapping for D1 (and SQLite in tests)                       |
| `views.ts`      | Runtime-free plain types safe for `app/` to import without Workers runtime types |
| `operations.ts` | Named Effect operations coordinating validation, claims, dispatch or publication |

Shared UTC date helpers live in `src/datetime.ts` (safe to share with the
browser). Display formatting stays in `app/src/lib/format.ts`.

## A useful reading order

Start with one end-to-end slice rather than the root Worker:

1. Run `pnpm workflow:fixture` and inspect `.local/workflow-fixture/run.json`,
   `portfolio-run.json`, and `api.log`.
2. Read `src/workflows/registry/index.ts`, `download-prices.ts`, and
   `normalize-prices.ts` to see how Effect-only and Python-backed steps declare
   contracts and retry policies.
3. Read `src/workflows/validate.ts` and `src/workflows/operations.ts` to see how
   complete specifications are validated and stored atomically.
4. Read `src/workflows/runs/operations.ts` and `src/workflows/runs/dispatch.ts`
   to follow atomic claiming, reconciliation, and daily UTC dispatch.
5. Read `src/workflows/executor.ts` and `src/definition-run-workflow.ts` to see
   how Effect programs execute inside Cloudflare Workflows checkpoints and waits.
6. Read `containers/engine/src/data_service_engine/operations/registry.py`,
   `normalize_prices.py`, and `portfolio_volatility.py` for the Python service.
7. Finally read `src/index.ts`, `src/routes/index.ts`, and `src/dependencies.ts`.

## Effect in this codebase

The root package pins Effect **4.0.0-rc.118** (see
[the v4 documentation](https://effect.website/docs/v4/getting-started/creating-effects/)).

- **An Effect describes work:** `Effect.Effect<A, E, R>` names its success type
  `A`, expected failure type `E`, and required services `R`. Business operations
  return Effects; pure helpers (`latestOccurrence`, `previousDay`, reference
  parsing) stay ordinary functions.
- **Read generators top to bottom:** operations use
  `Effect.fn("Name")(function* (...) { ... })`. `const store = yield* Workflows`
  obtains an injected service; `yield* store.create(...)` executes a step on it.
- **Services and Layers:** `Context.Service` keys live in `store.ts` or
  `client.ts`; real Cloudflare adapters end in `Live` (`D1WorkflowsLive`,
  `R2RunArtifactsLive`, `HttpPythonOperationsLive`). `src/dependencies.ts` wires
  them from `CloudflareBindings`; `src/local/runs.ts` wires local equivalents
  using the exact same interfaces.
- **HTTP edge translation:** `runHttp(program, layer)` in `src/http/run-effect.ts`
  provides dependencies and maps `AssetError`, `PortfolioError`, `WorkflowError`,
  and `DatasetError` to HTTP status codes. Never call `runHttp` from domain
  operations.
- **Expected failures vs defects:** wrap fallible external I/O with
  `Effect.tryPromise({ try, catch })` into a typed tagged error rather than
  `Effect.promise`. Validate external payloads with Effect Schemas at runtime.

## Failure recovery and durability rules

Every recovery policy lives in one place and is exercised by both local tests
and the [Cloudflare recovery smoke test](/docs/operations/workflow-smoke/):

| Mechanism                       | Behavior                                                                                                                                                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bounded transient retries**   | Each step type declares its retry policy (default: 3 retries with exponential backoff — 10 s, 20 s, 40 s — and 10 min attempt timeout) for provider, R2, D1, and 5xx/network Python errors.                                                                                  |
| **Terminal errors**             | Invalid params/inputs, unknown step types, schema mismatches, outputs over 32 KiB, and Python `422` domain errors throw `NonRetryableError` and stop the run immediately.                                                                                                    |
| **Captured definition**         | A run captures its workflow's name and step list when claimed. Editing a workflow affects subsequent runs while active runs replay their original sequence safely.                                                                                                           |
| **Atomic claims & overlap**     | Partial unique indexes (`workflow_runs_one_active`, `workflow_runs_one_per_occurrence`) allow one active run per assignment and one run per scheduled occurrence. Overlaps record `skipped`.                                                                                 |
| **Launch reconciliation**       | Workflow instance ID equals `runId`. If launch confirmation is lost, the next submission or hourly tick checks status before claiming. Unknown lookup status never releases a claim; stopped instances fail the run and release the slot.                                    |
| **Durable dependency waits**    | `wait-for-asset-publications` checkpoints its absolute deadline on the first check, sleeps durably between checks (up to 1 minute at a time), never resets its deadline on replay, never starts upstream runs, and fails with missing asset diagnostics on timeout.          |
| **Retry-safe Python & publish** | Python writes artifacts to deterministic `runs/<runId>/<stepId>/<name>.<ext>` paths. `publish-dataset` copies to the processed bucket first and upserts D1 metadata second; retrying after a lost Python response or failed metadata write overwrites the same path cleanly. |
| **Temporary artifact expiry**   | One R2 lifecycle rule deletes objects under `runs/` in `raw-market-data` 30 days after write. No scheduled cleanup job or D1 artifact index exists. Published datasets and retained pre-workflow `dataset=...` raw objects are unaffected.                                   |

## Adding a new step type

### Adding a Python-backed operation

1. Create a module under `containers/engine/src/data_service_engine/operations/`
   (use `portfolio_volatility.py` or `normalize_prices.py` as a template):
   - Define Pydantic `Contract` subclasses for `inputs`, `params`, request
     (`OperationRequest` subclass), and response.
   - Write large outputs under `run_artifact_id(request.execution, name, ext)` so
     retries overwrite the same artifact safely.
   - Raise `TerminalError` for invalid inputs or domain errors, and
     `TransientError` for retriable storage failures.
   - Export `OPERATION = Operation(...)` and register it in
     `operations/registry.py`.
2. Export JSON Schemas and regenerate TypeScript Effect Schemas from the repo
   root:

   ```sh
   pnpm operations:generate
   ```

3. Register a TypeScript step type in `src/workflows/registry/`:
   - Define contracts in `src/workflows/registry/contract.ts` if introducing a
     new port identity.
   - Call `defineStepType` with `scopes`, generated `params` schema, `inputs`,
     `outputs`, and an `implementation` calling `PythonOperations.invoke(...)`.
   - Add the step type to `builtInStepTypes` in `src/workflows/registry/index.ts`.
4. Add focused Python unit tests in `containers/engine/tests/` and an API /
   Python-HTTP acceptance test in `test/`.

### Adding an Effect-only step

1. Create a file under `src/workflows/registry/` (use `portfolio-holdings.ts` or
   `download-prices.ts` as a template).
2. Declare its `type`, `description`, `scopes`, `params` Effect Schema, named
   `inputs` and `outputs` with explicit contract identities, optional retry
   policy, and `implementation`.
3. Use existing `Context.Service` interfaces (`Assets`, `Portfolios`,
   `DatasetPublicationStore`, `RunArtifacts`, `MarketDataSources`) and map errors to
   `terminalStepError` or `transientStepError`.
4. Register it in `builtInStepTypes` in `src/workflows/registry/index.ts` and
   cover validation and execution through the `/api/workflows` and `/api/runs`
   test seam.

## Where to change common things

| Change                         | Start here; then check                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Asset CRUD or deletion guards  | `src/assets/d1.ts`, `src/routes/assets/index.ts`, `test/assets.test.ts`                        |
| Portfolio holdings rules       | `src/portfolios/contracts.ts`, `src/portfolios/d1.ts`, `test/portfolios.test.ts`               |
| Workflow specification rules   | `src/workflows/validate.ts`, `src/workflows/contracts.ts`, `test/workflows.test.ts`            |
| Step contracts & retry policy  | `src/workflows/registry/`, `test/workflow-runs.test.ts`                                        |
| Scheduled dispatch / claims    | `src/workflows/runs/dispatch.ts`, `src/workflows/runs/d1.ts`, `test/workflow-dispatch.test.ts` |
| Python operation logic/schemas | `containers/engine/src/data_service_engine/operations/`, then `pnpm operations:generate`       |
| Dataset publication & lookup   | `src/datasets/`, `src/routes/datasets/index.ts`, `test/dataset-publication.test.ts`            |
| SQL schema                     | New file in `migrations/`; real-SQL tests via `test/support/d1.ts`                             |
| HTTP error mapping             | `src/http/run-effect.ts`; relevant route tests                                                 |
| App pages & browser API        | `src/pages/views.ts`, `src/pages/index.ts`, `app/src/routes/`, `app/src/lib/api.ts`            |

## Local development and verification loop

No Cloudflare credentials are needed for the full local verification loop:

```sh
pnpm workflow:fixture       # end-to-end asset + portfolio workflow against fixtures (needs uv)
pnpm operations:check       # verify Pydantic schemas match generated TS contracts
pnpm format:check           # Prettier (TS, Svelte, JSON, Markdown)
pnpm typecheck              # TypeScript across src/, scripts/, test/
pnpm test                   # API, SQLite D1, fixture & contract tests
pnpm engine:test            # Python pytest (needs uv)
pnpm engine:lint            # Python ruff check + format (needs uv)
pnpm app:check              # svelte-check (0 errors, 0 warnings)
pnpm --filter app build     # Cloudflare SvelteKit build
pnpm docs:build             # Starlight docs build
```

On CPUs without AVX2, run Python tests with Polars' compatibility runtime:

```sh
uv run --directory containers/engine --with 'polars[rtcompat]' pytest
```

## Conventions

- Order declarations as **imports → constants → types/contracts →
  functions/classes**, keeping each declaration's documentation attached.
- Workflow domain and persistence records belong in their owning
  `contracts.ts`. Keep `views.ts` files as independent, browser-safe API DTOs,
  free of Worker/Effect runtime imports so SvelteKit can typecheck against them
  cleanly; duplication at this boundary is intentional. Import display
  projections directly from views, never reexport them from domain contracts.
- The cron handler and dispatcher reports use Effect logs: the event name is
  the JSON `message`, and structured fields are annotations. Entrypoints install
  `WorkerLoggerLive`; domain operations never call `console` or
  `JSON.stringify` for logs.
- Keep atomic database guards inside D1 batches and partial unique indexes
  rather than split application-level read-then-write checks.
- Test externally observable behavior at the public API / fixture boundary with
  real SQLite migrations and the real Python HTTP service.
