---
title: Maintaining the code
description: A reading path, a practical Effect walkthrough, and where to make common changes.
---

Start here when returning to the project. Read [Concepts](/docs/concepts/) for
the domain words and [Architecture](/docs/architecture/) for the Cloudflare
parts. This guide connects those parts to the source code.

The published docs under `docs/src/content/docs/` are the current architecture
and operations reference. `CONTEXT.md` is the short domain glossary. Files in
`.agent/` are historical design notes; check the implementation and current docs
before treating an old proposal as a requirement.

## The shape of the repository

There are two main background flows:

```text
Request downloads → ingestion queue → provider → raw R2 object
  → processing job + queue → Python processor → canonical Parquet

Start calculation → saved run → Workflow → Python engine
  → result Parquet → recorded outcome
```

The Worker owns state transitions in D1. Python reads and writes data in R2,
and reports its outcome to the Worker. The app reads page data on the server
and sends mutations through the Worker's JSON routes.

| Location                 | Read it for                                                         |
| ------------------------ | ------------------------------------------------------------------- |
| `src/index.ts`           | Cloudflare fetch, cron and queue entry points                       |
| `src/dependencies.ts`    | Concrete dependency wiring for HTTP routes and page reads           |
| `src/routes/`            | Authentication, request validation, HTTP responses                  |
| `src/http/run-effect.ts` | Shared execution of Effects and expected-error HTTP mapping         |
| `src/calculations/`      | Calculation configuration, run execution, scheduling, engine client |
| `src/portfolios/`        | Portfolio contracts, persistence interface and D1 implementation    |
| `src/market-data/`       | Registry, ingestion, processing, download schedule and status reads |
| `src/*-workflow.ts`      | Cloudflare Workflow entry points and dependency wiring              |
| `src/workflows/steps.ts` | Adapter between orchestration and Cloudflare's step runner          |
| `src/pages/`             | Read-only data supplied to SvelteKit pages                          |
| `app/src/routes/`        | Pages and their server loads                                        |
| `app/src/lib/api.ts`     | Browser requests to `/app-api`                                      |
| `containers/processor/`  | Raw response validation and Parquet rebuilds                        |
| `containers/engine/`     | Calculation types, execution and result storage                     |
| `migrations/`            | Database schema and concurrency constraints                         |
| `test/`                  | Worker behavior tests, usually using real SQL against SQLite        |

### File roles inside a feature

Calculations, portfolios and the download schedule use these names:

| File                  | Responsibility                                                                      |
| --------------------- | ----------------------------------------------------------------------------------- |
| `contracts.ts`        | Input schemas, values, typed errors and persistence input/result types              |
| `store.ts`            | The injectable persistence interface: what operations can ask storage to do         |
| `d1.ts`               | SQL and mapping between database rows and application values                        |
| `views.ts`            | Plain types that the app can import without loading Worker or Effect runtime code   |
| Named operation files | Business steps, such as `configure.ts`, `runs.ts`, `schedule.ts` or `operations.ts` |
| `workflow.ts`         | Durable orchestration: named steps, their ordering and retry configuration          |

Small existing features such as `symbol-registry` and `status` still keep their
interface and contracts together in `index.ts`. Split a module when its roles
become hard to find; there is no requirement to create every file in this table.

A store interface is a seam for supplying an implementation. A D1 adapter
implements it. An operation coordinates the work. Prefer explicit imports from
the owning file over a barrel that hides which role you are using.

Shared UTC date arithmetic lives in `src/datetime.ts`. Import it directly for
date cutoffs, day/hour rounding and duration constants; it is safe to share with
the browser. Feature modules keep scheduling decisions and timeout thresholds,
while locale-dependent display formatting stays in `app/src/lib/format.ts`.

## A useful reading order

Start with one operation rather than the root Worker:

1. `src/calculations/configure.ts`, then the create/update cases in
   `test/calculations.test.ts`.
2. `src/calculations/contracts.ts` for accepted input and
   `src/calculations/store.ts` for persistence operations.
3. `src/calculations/d1.ts` for what is actually stored.
4. `src/routes/calculations/index.ts`, `src/http/run-effect.ts` and
   `src/dependencies.ts` for how HTTP reaches that operation.
5. `src/calculations/runs.ts`, `src/calculations/workflow.ts`, then
   `src/calculation-run-workflow.ts` for background execution.
6. Python `types/ex_ante_vol.py`, then `market_data.py`,
   `portfolio_results.py`, `returns.py`, `framework.py` and `runtime.py` under
   `containers/engine/src/data_service_engine/`.
7. Finally `src/index.ts`: by then its cron and queue wiring has context.

## Effect, using this application

The root package pins Effect **4.0.0-rc.118**. Use
[the v4 documentation](https://effect.website/docs/v4/getting-started/creating-effects/)
when looking up constructs; examples written for v3 can use different names.
The installed version and its types are the final reference for this project.

### An Effect describes work

Read `Effect.Effect<A, E, R>` as:

- **A:** the successful value;
- **E:** the expected failures callers must handle;
- **R:** the dependencies the work needs.

An Effect is a description until something runs it. An ordinary Promise has
usually already started by the time you hold it.

The business functions in this project return Effects. The HTTP handler, queue
consumer, cron handler or Workflow step supplies dependencies and executes them.
Pure helpers such as `previousDay`, `isDue` and `parseCron` are ordinary functions.
They do not need Effect just because their caller uses it.

### Read generators from top to bottom

`createCalculation` in `src/calculations/configure.ts` is a named operation
created with `Effect.fn("Calculations.create")(function* (...) { ... })`.

Its steps are:

1. Ask the engine what the requested type is.
2. Check whether its portfolio selection fits that type.
3. Ask the engine to validate params and fill in defaults.
4. Save the calculation through the persistence interface.

Two lines from that operation illustrate the main distinction:

```ts
const engine = yield * Engine;
const params = yield * engine.validate(type.name, input.params ?? {});
```

The first line obtains a dependency. It does not call Python. The second line
runs an operation on that dependency and obtains its successful result. If it
fails, the rest of this generator does not run unless a handler recovers it.

`yield*` here plays a similar reading role to `await`, while retaining the
expected-error and dependency types. It does not make steps concurrent, create
a database transaction, or start a Cloudflare Workflow.

`Effect.fn` also gives this operation a name for diagnostics. Prefer a named
operation with sequential steps over deeply nested pipelines for business flows.

### A dependency key is an interface, not a row or a connection

`Calculations` in `store.ts` extends `Context.Service`. It is the typed key for
the persistence dependency and describes its methods. `yield* Calculations`
obtains the implementation supplied to this execution.

`D1CalculationsLive(db)` in `d1.ts` supplies that key with the D1 implementation.
The suffix `Live` means the real adapter rather than a test stand-in.

The HTTP wiring in `src/dependencies.ts` selects that adapter using the current
request's `MARKET_DATA_DB` binding. Tests can supply a different implementation
or use the same D1 adapter with the SQLite test database.

### Layers supply dependencies

A Layer is a recipe for supplying dependencies. It is not a background process.

- `Layer.succeed(Key, implementation)` supplies an existing implementation.
- `Layer.effect(Key, program)` builds one using an Effect; construction can
  require other dependencies or fail, as in the EODHD adapter.
- `Layer.merge(a, b)` supplies both sets of independent dependencies.
- `Effect.provide(layer)` attaches those dependencies to a program.
- `Effect.runPromise` executes a fully supplied program at an ordinary async edge.

`runHttp(program, layer)` combines providing, executing and mapping expected
failures into JSON HTTP errors. A route can focus on validating input, choosing
the operation and returning the successful response.

Do not call `runHttp` from business code. That would couple it to HTTP and
break reuse from a Workflow or queue. Page reads have their own execution helper
in `src/pages/index.ts` because SvelteKit needs `PageDataError`, not a Hono error.

`Calculations.use((store) => store.get(id))` is a short form for obtaining the
key and using it. It is convenient for a single read. Use a named local
`const store = yield* Calculations` when coordinating several steps.

### Expected failures and defects are different

`CalculationError`, `EngineError` and `PortfolioError` describe expected
failures. Their `_tag` identifies the family, and `kind` identifies the reason.
`src/http/run-effect.ts` maps these into status codes and safe error metadata.
Schema input failures are handled separately by `src/effect-validator.ts`.

`Effect.result` turns expected success/failure into a value you can inspect.
It does **not** convert unexpected defects into ordinary typed failures.

When adapting external I/O that can reject, use:

```ts
Effect.tryPromise({
  try: () => externalOperation(),
  catch: () =>
    new EngineError({
      kind: "unavailable",
      message: "The calculation engine could not be reached",
    }),
});
```

This is a schematic example: choose the error belonging to that adapter.
`Effect.promise` is appropriate only when rejection would be an unexpected defect.
Some existing queue sends still use it for fallible I/O; those are known review
follow-ups, not the recommended pattern for new work.

Likewise, a TypeScript assertion such as `body as RunResult` does not validate
an external value. Use a Schema decoder when establishing a runtime contract.
The engine response decoder is a known follow-up from the codebase review.

## Trace a request and a background run

### Create a calculation

1. `/api/calculations` checks the management token. `/app-api/calculations`
   checks Access and same-origin mutation rules. Both mount the same routes.
2. `effectValidator` checks `CreateCalculationSchema` from `contracts.ts`.
3. The route calls `createCalculation` with an ID and timestamp.
4. `runHttp` supplies the calculation-store and engine layers.
5. The operation validates the type, portfolios and params, then asks the store
   to create the record.
6. `d1.ts` checks portfolio existence and saves the calculation and its ordered
   portfolio selection in a transactional batch.
7. The route returns 201; expected errors follow the shared HTTP mapping.

Changing the validation rule should not require editing HTTP plumbing.
Changing the response shape may require updating `views.ts`, the app's request
helper and its presentation.

### Run a saved calculation

`startRun` in `runs.ts` checks for stopped runs, saves a run with its params,
then creates a Cloudflare Workflow. The one-running-run database index makes a
second request record a skipped run.

The thin Cloudflare entry point builds the real layers and passes them to
`executeRun` in `workflow.ts`. That orchestration has named steps for running
the calculation and recording its outcome. `calculateRun` loads portfolios,
calls the engine and combines the portfolio outcomes.

The engine validates params and invokes the selected Python type once with the
whole request. The type chooses its data helpers and returns a
`CalculationResult`; the runtime conditionally writes successful result history
to R2. The Worker records the response in D1. Python never updates D1 itself.

### Follow a Python calculation

Start at `types/ex_ante_vol.py` or `types/hypothetical_portfolio_returns.py`:

1. `run(params, ctx)` opens `market_data(ctx.as_of, ctx.load_symbol)`. Data
   acquisition belongs to the calculation; no symbols are preloaded by runtime.
2. In its own loop, the type calls `load_portfolio_data(portfolio, data)`. This
   functional helper selects calculation-date holdings and loads their raw
   prices. `MarketData.load` clamps dates; `SymbolReader` caches object reads.
3. The type calls `calculate_portfolio(params, inputs)` directly. That function
   uses `price_returns(inputs.prices, symbols)` and performs the numerical work
   without I/O. The type's explicit `try`/`except` handles failures;
   `portfolio_rows` tags completed rows and `portfolio_result` summarizes the
   recorded outcomes. These helpers never invoke calculation code.
4. `CalculationType.calculate` checks declared value columns and stamps `as_of`.
5. `runtime.py` returns the rows for synchronous calls or persists a successful
   saved result. It uses the result status without inferring it from portfolios.

To add a symbol calculation, read symbols through the same data helper. To add
an aggregate, consume `ctx.portfolios` together. Neither requires runtime
handling for that shape. `takes_portfolio` is catalog/UI metadata, not an engine
execution switch. See [Writing a calculation type](/docs/calculations/types/)
for complete examples and the input, result and helper contracts.

`src/workflows/steps.ts` supplies a shared, platform-typed step interface. Step
results must be serializable. Successful results are durable, but a step body
can run more than once when an attempt fails. Keep stable step names and make
side effects safe to retry. Effect execution alone provides no durable replay.

## Recovery rules to know before changing orchestration

These describe current behavior, including limitations. They are not guarantees
that every infrastructure failure will automatically recover.

| Work                       | Ownership and recovery                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingestion                  | One fetching run per symbol. Queue redelivery may create a fresh run. Fetching runs older than 30 minutes are failed when a new attempt starts.                                                         |
| Processing                 | D1 atomically claims a queued job. Unreachable-container failures release it for queue retry. HTTP error responses currently fail the job permanently.                                                  |
| Processing reconciliation  | At 02:00 UTC, cron fails processing jobs older than one hour, creates eligible new jobs and resends queued jobs. Failed jobs are not automatically retried for the same ingestion run.                  |
| Download schedule          | One scheduled run per UTC day. Its Workflow queues batches. Creation failure is reconciled against an existing instance; otherwise the scheduled record is removed for a later tick.                    |
| Calculation schedule       | One claimed slot per calculation. Launch failure currently consumes the slot. Disabled calculations do not start scheduled runs.                                                                        |
| Calculation execution      | The engine step has two retries and a 30-minute timeout. Python currently returns many infrastructure exceptions as normal failed results, bypassing those retries.                                     |
| Stopped calculation checks | Runs older than five minutes are checked before a new run and on hourly cron. Lookup failures currently look like missing instances; fix this before relying on it to release ownership during outages. |

Dev has no cron. Actions that rely on a sweep need an explicit trigger there.
The limits and delivery settings are in `wrangler.jsonc`; constants live beside
the operation that owns the policy.

Runs save params but reload portfolio selections, holdings and current canonical
market data later. An as-of filter limits the dates visible to the calculation;
it does not restore the dataset as it existed historically. Full input freezing
and provenance remain separate improvements.

## Where to change common things

| Change                            | Start here; then check                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Calculation input fields          | `calculations/contracts.ts`; `configure.ts`, `d1.ts`, `views.ts` and the app form as needed           |
| A calculation rule                | `calculations/configure.ts`; create/update cases in `test/calculations.test.ts`                       |
| Calculation execution             | `calculations/runs.ts`; durable ordering/configuration in `workflow.ts`                               |
| A new calculation type            | `containers/engine/src/data_service_engine/types/`; [Adding a type](/docs/calculations/types/)        |
| Portfolio editability             | `portfolios/d1.ts`; `test/portfolios.test.ts`                                                         |
| Automatic single-asset portfolios | `market-data/symbol-registry/d1.ts` and `migrations/0008_single_asset_portfolios.sql`; registry tests |
| Download hour and due rules       | `market-data/schedule/operations.ts`; `test/schedule.test.ts`                                         |
| Download batching                 | `market-data/schedule/workflow.ts`; schedule tests                                                    |
| Queue retry decisions             | `market-data/ingestion-queue.ts`, `market-data/processing.ts`, and `src/index.ts`                     |
| SQL schema                        | A new file in `migrations/`; relevant D1 adapter and real-SQL tests                                   |
| HTTP error status/metadata        | `http/run-effect.ts`; relevant route tests and API reference                                          |
| Page reads                        | `src/pages/index.ts` and `views.ts`; corresponding `+page.server.ts`                                  |
| Browser mutations                 | `app/src/lib/api.ts`, the form/detail component and reused Worker route                               |

Portfolio protection and single-asset creation currently live in the D1 adapters
so checks and writes can stay close to atomic persistence. Preserve the database
constraints and transactional batches when making those rules more discoverable.
Do not replace an atomic batch with separately failing application writes.

## A development loop that does not need Cloudflare credentials

Install dependencies, then use the calculation behavior tests as a local
walkthrough:

```sh
pnpm install
pnpm exec tsx --test --test-name-pattern='creating a calculation' test/calculations.test.ts
pnpm exec tsx --test --test-name-pattern='a run sends every portfolio' test/calculations.test.ts
```

`test/support/d1.ts` applies the real migrations to in-memory SQLite.
`test/support/engine.ts` supplies an HTTP stand-in for Python. The Workflow fake
in the calculation tests executes named step bodies directly. These tests show
what gets saved and sent without secrets, deployed queues or R2.

Run `pnpm format` after editing supported source, configuration or documentation
files. The repository configuration includes Svelte support and is shared with
editor integrations. Python formatting remains with Ruff.

For a change, run the relevant test file, then the shared checks:

```sh
pnpm format:check
pnpm test
pnpm typecheck
pnpm app:check
pnpm --filter app build
pnpm docs:build
```

Use Node 22.23.4 or later in the 22.x line for the current docs dependencies.
See [Local development](/docs/operations/local/) for the two-server app setup and
its R2/container limitation. Root typechecking imports the generated app handler;
run the app build first on a fresh checkout to generate it if necessary.

For Python changes:

```sh
pnpm processor:test
pnpm processor:lint
pnpm engine:test
pnpm engine:lint
```

On CPUs without the required instructions for the default Polars runtime:

```sh
uv run --directory containers/processor --with 'polars[rtcompat]' pytest
uv run --directory containers/engine --with 'polars[rtcompat]' pytest
```

Use tests of externally observable behavior: accepted input, saved state,
outbound engine requests and error/recovery outcomes. Keep the real-SQL tests.
The current fakes do not verify actual Cloudflare checkpoint replay, timeout or
serialization behavior; orchestration changes may need runtime integration tests.

## Conventions for the next change

Order module declarations as **imports → constants → types/contracts →
functions/classes**. Schema values belong with constants; a function assigned
to `const` belongs with implementations. Keep runtime contract classes before
the functions using them, and keep each declaration's documentation attached.
If a TypeScript constant calls a local helper during initialization, use a hoisted function
declaration so it can still be defined below the contracts.

In Svelte components, put static constants before props/state and retain the
dependency order of reactive setup. Eager registrations that require completed
definitions (such as Python calculation `TYPE`) stay after those definitions.

- Give an operation a domain name and keep its steps sequential and readable.
- Use plain functions for pure policy, Effect for fallible coordinated work,
  and async functions where Cloudflare controls the durable step lifecycle.
- Name dependencies before using them; avoid nested `yield*` expressions.
- Supply real adapters at execution edges. Pass small external handles such as
  queues explicitly when that makes the operation's needs clear; do not add a
  dependency key for every argument.
- Keep HTTP error translation in `runHttp`; keep schema validation in the validator.
- Keep runtime-free view types separate for browser imports.
- Prefer a small interface that hides meaningful work. Avoid pass-through
  layers, compatibility barrels and one-file-per-helper rules.
- Update the relevant behavior test and this map when responsibilities move.
