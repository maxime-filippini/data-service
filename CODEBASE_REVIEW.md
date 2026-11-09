# Codebase review: maintainability, structure, and learning Effect

Reviewed 2026-11-09, against commit `21b9f9e` and the working tree. Application code was not changed.

## Assessment

The architecture is reasonable for this project's requirements. The difficulty you describe is real: understanding an operation requires reconstructing relationships between route factories, Effect programs, dependency interfaces, layers, SQL, Cloudflare handlers, and sometimes a second language. File-level code is generally clear; whole-system readability is weaker.

My recommendation is to keep the architecture, keep a restrained subset of Effect, repair the error/retry contracts, and make the code navigable around the things you do with it. A framework rewrite or a new generic repository/use-case hierarchy would add work without addressing the main causes of confusion.

There are three distinct sources of complexity:

- **Inherent:** durable background work, duplicate delivery, state transitions across D1 and R2, a Python calculation engine, authentication, and browser/server execution.
- **Learnable:** Effect's generators, typed failures, dependency requirements, and layers.
- **Avoidable:** inconsistent dependency injection, ambiguous file names, repeated runtime adapters, hidden business rules in SQL adapters, unsafe contract casts, and competing documentation.

The goal should be to reduce the third category and explain the second in terms of this application. You should not need to become an Effect expert to change a portfolio rule.

## Scope and verification

I reviewed the Worker entry points and wiring; ingestion, processing and both scheduling paths; calculation configuration and execution; D1 adapters and migrations; authentication and routes; the SvelteKit integration and representative app flows; both Python runtimes, the calculation framework and volatility implementation; tests, CI, configuration and documentation. This is a maintainability and correctness review, not a deployed security audit, load test, or independent validation of the financial model.

Executed checks:

| Check | Result |
| --- | --- |
| TypeScript tests | 102 passed |
| Worker typecheck | Passed |
| Svelte check | 0 errors, 0 warnings |
| App production build | Passed |
| Processor Python tests | 19 passed with the documented Polars compatibility runtime |
| Engine Python tests | 46 passed with the compatibility runtime |
| Ruff lint and format checks, both Python projects | Passed |
| Docs build | Blocked: local Node 22.22.1 is below Astro's required 22.23.4 |

The ordinary processor test command initially crashed while importing Polars with an illegal instruction. The repository already documents `uv run --with 'polars[rtcompat]' pytest`; using that resolved the problem. This is an environment issue, not evidence of a processor logic failure.

I also ran two small, isolated reproductions against the installed Effect version: a transient Workflow lookup error caused an active run to be marked failed, and a queue send rejection escaped `Effect.result` as a defect. Neither reproduction changed application files or contacted deployed resources.

## What is already working well

1. **The Worker/Python split is clear.** The Worker owns D1 state; Python receives explicit requests and handles data work. Containers do not call back into the Worker or independently mutate run state. Preserve this.
2. **Full-history rebuilds simplify the pipeline.** Immutable raw objects and stable canonical keys make recovery easier to reason about than incremental merging. Retrying still needs precise contracts, as discussed below.
3. **The database enforces important invariants.** Partial unique indexes, foreign keys, conditional updates and transactional batches provide real protection. This is stronger than relying on application-level checks alone.
4. **HTTP input validation is centralized.** `src/effect-validator.ts` and the domain schemas provide consistent validation rather than scattered manual checks.
5. **The TypeScript tests exercise real SQL.** `test/support/d1.ts` applies real migrations to SQLite. These tests cover substantially more than mocked method calls, and should remain the main persistence tests.
6. **The Python calculation framework has useful depth.** `CalculationType` hides parameter validation, iteration over portfolios, output validation and reserved columns behind a small interface. The volatility implementation can concentrate on the calculation. This abstraction earns its keep.
7. **The two HTTP entry surfaces reuse routes.** Management-token and Access-authenticated requests reuse the same mutation handlers. Preserve that sharing.
8. **Authentication and observability show care.** Access checks validate issuer, audience and allowlisted email; app mutations check origin; management tokens use digest comparison; logs and traces are enabled; the EODHD adapter suppresses tracing of its token-bearing URL.

## Priority 1: fix misleading failure and recovery behavior

### 1. A Workflow lookup outage can falsely release an active calculation

**Evidence:** `src/calculations/runs.ts:24` (`workflowStatus`) converts every rejection from `get()` or `status()` into `null`. `failStoppedRuns` treats `null` as proof the Workflow never started, marks its D1 run failed, and frees the one-running-run slot.

**Reproduction:** a fake Workflow binding that throws `temporary network failure` caused a five-minute-old active run to be failed with `The run's workflow never started`.

**Why it matters:** a monitoring failure can change execution state. A new run can start while the original Workflow is still doing work. Conditional result writes help with simultaneous writes, but do not make it safe to release execution ownership on an unknown status.

**Change:** distinguish confirmed missing, known stopped, known active, and lookup unavailable. An unavailable status should log a diagnostic and leave the run alone. Test both `get()` and `status()` failures, and confirm that neither frees the slot.

There is a related inconsistency in `startRun`: a rejected `workflow.create()` immediately fails the run. The download scheduler already tries to reconcile an ambiguous create response by checking for an existing instance (`src/market-data/schedule/index.ts:92`). Apply one deliberate creation/reconciliation policy to both paths, including the possibility that the status check itself fails.

### 2. Transient Python failures bypass the configured calculation retries

**Evidence:** `containers/engine/src/data_service_engine/runtime.py:43` catches every exception and returns `RunResult(status="failed")`. `framework.py:123` also catches every per-portfolio exception and converts it into an outcome. `/runs` returns HTTP 200 for these results. `executeRun` therefore sees a successful step return and records the failure without exercising `ENGINE_STEP`'s retries.

**Example:** an R2 read timeout, temporary write failure or conditional-write conflict can become a terminal result rather than a retryable step failure. A single portfolio's storage failure can become `partial`, also without a retry.

**Change:** define the contract across both languages:

- Expected calculation failures, such as insufficient observations, produce explicit portfolio outcomes.
- Retryable infrastructure failures propagate as distinguishable failures so the durable step can retry.
- Unexpected programming failures remain visible and retain diagnostic context.

Do not solve this only by changing HTTP status codes. Preserve the error category through the Python framework, Python runtime, HTTP client and Workflow. Add failure-injection tests for R2 reads/writes and conditional conflicts. Cloudflare retries failed steps; returning a normal failure-valued result is a separate application decision ([Workflow retry documentation](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)).

### 3. Queue sends accidentally use Effect's defect channel

**Evidence:** `requestIngestions` (`src/market-data/ingestion-queue.ts:69`) and `scheduleProcessing` (`src/market-data/processing.ts:36`) wrap `sendBatch()` in `Effect.promise`.

`Effect.promise` is for promises expected not to reject. A rejection becomes a defect, outside the declared error type. `Effect.result` handles typed failures, so the surrounding code does not receive the failure it appears prepared to handle. I reproduced an outer failing `Exit` containing `Die` after applying `Effect.result`.

**Change:** use `Effect.tryPromise` and an explicit queue error. Decide at the caller whether to return an HTTP failure, retry, or leave durable work for reconciliation. Keep a final defect-reporting handler at execution edges so unexpected bugs are logged consistently. Avoid translating every defect into a successful value. See [Effect v4 constructors](https://effect.website/docs/v4/getting-started/creating-effects) and [unexpected errors](https://effect.website/docs/v4/error-management/unexpected-errors).

Batching also creates partial acceptance: if the first batch sends and the second fails, some work is already queued. The current promise of queueing nothing applies to validation rejection, not infrastructure failure. Document that distinction and make client retries safe; only add an outbox if stronger durable acceptance becomes a requirement.

### 4. Processor HTTP failures become terminal jobs, even when transient

**Evidence:** `src/market-data/processing.ts:67` releases and retries a job when `fetch()` rejects, but every non-2xx response is recorded as failed. The Python processor turns exceptions, including storage failures, into HTTP 500 (`containers/processor/src/data_service_processor/app.py`). The pending-job SQL excludes any run that has already had a job, including a failed one.

**Consequence:** a temporary R2 outage returned as 500 does not use queue retries. The next sweep does not retry that same failed job/run; a new ingestion is needed.

**Change:** classify retryable responses separately from invalid manifests or permanent data errors. Requeue retryable failures with a bounded attempt policy and a visible final state. Add an explicit retry/rebuild operation if users need to recover a job without downloading everything again. Preserve the existing atomic claim behavior.

## Priority 2: make execution inputs and contracts trustworthy

### 5. A calculation run snapshots params, but reads other inputs later

**Evidence:** `startRun` stores params, but `calculateRun` reloads the current calculation's `portfolioIds` and current holdings snapshots (`src/calculations/runs.ts:71–121`). The engine then reads the current canonical market-data objects.

Changing the calculation's portfolios after starting a run can change what that run executes. A retried engine step can load different holdings or data than an earlier attempt. Old runs cannot fully explain or reproduce their outputs from the saved params alone.

**Change:** choose an explicit reproducibility level. At minimum, freeze ordered portfolio IDs and the holdings input used for execution, and record which input/configuration version the run used. For stronger reproducibility, retain or record accessible market-data versions, code version and engine type version. Recording an ETag alone does not retain the old object.

This does not require retaining every historical input immediately. It does require describing the current semantics accurately: an as-of date filters current history; it does not reconstruct exactly what was known on that historical date.

### 6. Engine responses are asserted to be valid rather than decoded

**Evidence:** `src/calculations/engine.ts:129` casts `response.json()` to `Promise<A>`. `listTypes`, `validate` and `run` rely on that cast. Valid JSON with missing or wrong fields passes through. Request validation is stronger than validation of this cross-language interface.

**Change:** decode the three finite JSON response shapes and report a typed protocol error. Leave the intentionally streamed ad hoc response streamed. Use shared fixture examples or generated wire schemas to check Python serialization aliases and TypeScript decoding together. A giant generated client framework is unnecessary.

The queue ingress has a similar gap: ingestion messages are cast, then destructured without validation, whereas processing messages check `jobId`. Decode queue envelopes at entry so malformed messages have a deliberate ack/retry/dead-letter policy.

### 7. Timeout scope is narrower than the comments imply

**Evidence:** `EngineLive.call` applies a timeout to the fetch effect, then processes error bodies afterward; successful JSON parsing is also outside that timeout. A response whose headers arrive but whose body stalls can outlast the advertised timeout.

**Change:** for JSON operations, include fetch, body reading and decoding under one timeout. For ad hoc streaming, explicitly choose a deadline for acquiring the response versus a deadline for consuming it, and explain the cancellation behavior. A Worker timeout or Workflow timeout must not be assumed to stop Python side effects automatically; verify that contract with a targeted runtime test.

### 8. Some outcome semantics need explicit product decisions

These are observable behaviors or risks, rather than all being unconditional defects:

- **Missing data has inconsistent HTTP semantics.** README and calculation docs promise 422 for expected missing prices. The framework converts that exception into an outcome, `runtime.calculate` wraps it as `CalculationFailed`, and the route returns 500. `containers/engine/tests/test_app.py:173` currently asserts the 500. Pick a contract and align code, tests and docs; preserving expected-versus-unexpected errors is preferable.
- **Failed reruns preserve previous successful output.** When all portfolios fail, the runtime returns before `write_results`; a partial result replaces all rows for the date with successful rows only. Both policies can be defensible, but readers need provenance to understand which run produced the stored rows. Consider run ID/configuration version in output or accompanying metadata.
- **Empty full-history responses can replace good history with an empty file.** `EodEntriesSchema` accepts an empty array, and the processor rebuilds from it. Define when empty data is legitimate, and guard suspicious empty or sharply reduced replacements. A valid JSON schema alone does not guarantee a safe historical replacement.
- **Scheduled calculation launch failures consume the slot.** `claimSlot` happens before the Workflow launch, and tests explicitly assert no retry of a failed slot. This differs from download scheduling's retry policy. Keep it only as a deliberate, documented rule; otherwise introduce recoverable launch state rather than blindly clearing the slot and risking duplicates.
- **Processing reconciliation runs once daily, and dev has no cron.** The fallback after a failed processing send can wait until the next 02:00 sweep; in dev it needs an explicit trigger. Document and expose a recovery action. Add a more frequent reconciliation cadence if that delay is unacceptable.

## Structure: why it feels harder to read than individual files suggest

### 9. File names conceal roles

`calculations/index.ts` holds schemas, error definitions, persistence types, exports and a dependency interface. `market-data/schedule/index.ts` additionally contains scheduling policy and a Workflow body. `portfolios/d1.ts` contains both storage operations and editability rules. `control-plane` is accurate infrastructure terminology but gives a returning reader little clue that it stores ingestion runs and processing jobs.

Use explicit names where there are several responsibilities: `contracts.ts`, `store.ts`, `d1.ts`, `configure.ts`, `runs.ts`, and `schedule.ts`. Prefer names such as `ingestion-and-processing-store` to a vague control-plane name if you rename that module. Keep entry/barrel files small. Avoid splitting every interface or helper into its own file; that would increase navigation cost.

The directory tree should answer “where do I change how a calculation starts?” and “where is a portfolio allowed to change?” without requiring symbol search.

### 10. Callers learn too much dependency wiring

Dependency supply varies between Effect services, plain `Pick<Queue<...>>` arguments, an object of layer factories in `services.ts`, a provider-to-layer callback, and generic `run(program)` callbacks in Workflows. Each pattern is defensible alone. Together they create several ways to answer the same question: “what does this operation need?”

**Recommendation:** keep Effect dependency interfaces for infrastructure that varies in tests or behavior, keep concrete Cloudflare wiring at the entry points, and expose a small set of operations per feature. Start with calculations as the exemplar:

- Public operations: configure, start a run, execute a run, and read views.
- Internal dependencies: calculation storage, portfolio loading, engine client and durable execution.
- HTTP handlers validate input, call an operation and translate its outcome.

A deep module hides the assembly callers do not need to understand. It can still have internal seams for SQL and failure-injection tests. Do not wrap every store method in an identically named pass-through function. Retain straightforward direct reads where they are already clear.

### 11. Domain rules are mixed into D1 implementation details

Single-asset portfolio immutability lives in the D1 portfolio adapter; automatic portfolio creation lives in the symbol registry's SQL batch. These rules are correctly enforced, including useful atomicity, but a reader looking for portfolio policy must discover them inside SQL-oriented files.

Make the business operation and invariants discoverable in named functions and module documentation. Keep atomic persistence steps together. Do not extract a generic repository and inadvertently turn one atomic registration into several independently failing writes. The goal is clearer ownership, not the maximum number of layers.

### 12. Repeated Effect-to-HTTP translation adds noise

Route modules repeatedly construct layers, provide them, turn typed failures into Results, run the program, inspect it and throw an HTTPException. Error metadata and mappings are distributed, and one route imports another route's mapping.

Extract a small execution/error-response helper with feature-specific mapping where needed. Make expected errors visible, preserve private diagnostic causes in logs, and provide one unexpected-error reporting path. Avoid a generic application framework with an elaborate handler registry.

### 13. App/Worker type integration is an awkward but localized seam

`src/pages/app.ts` is a declaration facade, `app/tsconfig.json` points at it, Vite bundles the real implementation, and `app/src/lib/server/data.ts` uses `env as never`. The generated SvelteKit handler is imported with `@ts-expect-error`. The existing `satisfies` checks are helpful; this is not simply careless casting.

Keep this workaround in one documented place, provide a typed declaration for the generated handler if feasible, and retain a full app/Worker build check. If contracts keep expanding, create a small workspace package for plain wire/view types and pure shared code. Do not create that package just to relocate a handful of files.

Workflow adapters also use `as never` to bridge custom `Steps` interfaces. Constrain step results to supported serializable values and make the adapter compile against installed Cloudflare types. Correct the comment “Each named step runs once”: successful output is durable, but execution can retry. [Cloudflare's rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) explicitly require thinking about idempotency.

## Effect: what to keep, what to simplify, and how to learn it here

Effect provides useful typed failures and testable dependency supply here. Most business programs already use sequential generators; the project is not buried in advanced functional abstractions. Removing Effect would mean replacing those capabilities and rewriting a working test suite. I would first make its use more consistent and then reassess your comfort on one simplified feature.

You need a small vocabulary:

| Code | Meaning in this repository |
| --- | --- |
| `Effect<A, E, R>` | A description of work producing A, with expected failures E, requiring dependencies R |
| `Effect.fn(...)(function* ...)` | A named operation, written as sequential steps; also supplies tracing context |
| `yield* someEffect` | Execute that step as part of this program and use its successful value |
| `yield* Calculations` | Ask the environment for the calculations dependency; it performs no database query itself |
| `Context.Service` | A typed dependency key plus its interface |
| `Layer.succeed(Tag, implementation)` | A recipe supplying an existing implementation of that dependency |
| `Layer.effect(...)` | Build a dependency using an Effect, potentially with its own failures and requirements |
| `Effect.provide(layer)` | Supply dependencies to the program |
| `Effect.runPromise` | Execute the fully supplied program at an ordinary async entry point |
| `Effect.result` | Turn expected failures into inspectable values; defects remain a separate failure mechanism |
| `Effect.tryPromise` | Adapt I/O that may reject into a typed failure |
| `Schema` | Validate external values at runtime; a TypeScript type assertion does not do this |

The central distinction is that an Effect is a description until run. A Layer is dependency construction, not a background process. `yield*` gives sequential code; it does not automatically imply concurrent work or database transactions.

Suggested local conventions:

1. Use plain functions for pure computations, such as date selection, counting and scheduling decisions.
2. Use generators for business flows with multiple dependent steps. Prefer named local values over nested expressions such as `(yield* Engine).validate(...)` when the extra line improves reading.
3. Adapt external failures once, near the I/O implementation, using meaningful typed categories.
4. Supply dependencies and execute at HTTP, queue, cron and Workflow entry points. A Workflow step is an intentional execution edge because Cloudflare controls its durability.
5. Standardize time handling. Some operations accept `now`, others call `new Date()` internally, and IDs are generated at different depths. Use either the installed Effect clock facilities or explicit time/ID inputs consistently where tests need control; do not add a custom clock abstraction without a need.
6. Keep the pinned v4 release-candidate version and link v4 documentation. Do not learn this code from v3 examples or change major Effect patterns as an incidental cleanup.
7. Keep tracing vocabulary consistent. `Effect.fn` names are a useful start; preserve original infrastructure causes in private logs without including provider tokens or secrets.

A good local Effect guide would annotate one existing operation, show its dependency construction, show its test layer, and explain its expected failure versus defect behavior. A general tutorial alone will not bridge the code navigation problem.

## Frontend maintainability

The app uses understandable local state, reusable forms and a shared request helper. Large `.svelte` files include substantial markup and CSS; line count alone is not a reason to split them.

The opportunities are more specific:

- `CalculationDetail.svelte` combines mutation state, data refresh, polling, error presentation and rendering. Extract the refresh/polling behavior only if it makes lifecycle and race handling clearer.
- Its `setInterval` can overlap requests if a load takes longer than five seconds, and responses have no stale-request guard. The explorer already has a `latestRequest` guard; reuse the principle. Prefer one in-flight poll, cancellation on teardown and protection against old responses overwriting newer state.
- Similar `busy/error/message`, action wrappers and error-string helpers recur across forms/details. Consolidate the stable repeated behavior, while keeping field rules local.
- `CalculationForm.svelte` computes patches with generic JSON-string comparison and a cast into a domain object. For a fixed set of fields, explicit comparison is easier to audit; use structured comparison for params where necessary.
- `parquet.ts` loads the entire file, decodes all rows, then builds another row representation for the table. This is acceptable for modest files. Document the intended size, add loading/cancellation behavior, and consider a Web Worker or selective/range reading when measurements show a problem. Do not rebuild the explorer preemptively.
- Session-scoped calculation-type state is deliberately browser-only today. Preserve that constraint if its loader moves; a module-level mutable store must not accidentally become server request state.

## Tests, CI and developer experience

Keep the existing real-SQL tests. Add tests around the failure contracts identified above rather than replacing behavior tests with mocks or snapshots of implementation details.

The main gaps are at runtime seams:

- Workflow fakes call step bodies directly. They do not verify checkpoint replay, serialization, actual timeout behavior or ambiguous creation.
- Python and TypeScript tests mostly validate their own separately authored contract expectations. They can both pass while production semantics disagree.
- The root Worker handler, queue routing and generated SvelteKit integration lack the same direct coverage as the extracted feature functions.
- There are no browser interaction tests exercising the forms/polling/navigation flows.

Add a small number of integration tests: one ingestion-to-processing path, one calculation-to-recorded-result path with a transient retry, and one app mutation/readback path. Run runtime-specific tests under the relevant Cloudflare tooling. Keep the fast Node/SQLite suite as the everyday loop.

CI checks TypeScript, the app, docs and both Python projects. The app's production build currently happens during deployment rather than in the PR check job. Add it to PR checks so integration-build failures are caught before deployment.

Declare a supported Node version and package-manager version at the root, with a version-manager file or equivalent setup instruction. The docs build failure encountered during this review is exactly the kind of avoidable onboarding friction that makes an unfamiliar codebase feel unreliable. Consider one `check` script composing the existing commands, with a documented compatibility-runtime variant for Python tests.

The shared dev deployment is explicitly documented. Its latest deployment and accumulated migrations can differ from the branch you are reading. Show the deployed commit/version somewhere easy to inspect. Migration-per-branch isolation would be more expensive; add it only if shared-environment collisions become frequent.

A complete local pipeline currently mixes simulated Worker R2 with containers reading real R2. Short term, offer deterministic fixtures or a fake engine/processor development mode so ordinary app and workflow work can be exercised predictably. Longer term, align both sides on the same local object-storage endpoint if full local end-to-end development matters. Avoid making every small edit require a remote deployment.

## Documentation and your reading path

The repository has more documentation than the onboarding experience suggests, but it is organized primarily as product/operations reference. The missing document is a maintainer's explanation of where code lives and how one operation works.

There are also concrete navigation problems:

- README links to `docs/ARCHITECTURE.md` and `docs/calculation-engine.md`, which do not exist there. Related material is under `.agent/` and the docs content tree.
- `.agent/ARCHITECTURE.md`, the published docs and the README overlap. Their authority and maintenance relationship are unclear.
- `dashboard/` contains old local build/dependency artifacts; the actual app is under `app/`. Label or remove obsolete local artifacts through normal housekeeping so the tree tells one story.
- The architecture page lists a symbol/run inspection capability as unimplemented even though the app JSON surface exposes status; clarify whether the intended missing capability is specifically a management-token endpoint.

Create one maintainer guide and link it prominently from README. It should contain:

1. The five things you can do: register symbols, request downloads, rebuild data, configure portfolios/calculations, and run calculations.
2. An exact file path for each operation and the main tests that explain it.
3. One annotated Effect flow and its layer wiring.
4. A state-transition/retry table: who owns a state, which failures retry, how stale work is detected, and how to recover it.
5. “Where to change X” examples, including adding a calculation type, changing a portfolio rule, and changing a response field.
6. A tiny fixture-backed walkthrough that succeeds locally.

For you specifically, start in this order:

1. `CONTEXT.md` for domain words, then `docs/src/content/docs/architecture.md` for the runtime parts.
2. `src/calculations/configure.ts`: a manageable business operation demonstrating generators and dependencies.
3. The create/update cases in `test/calculations.test.ts`, then `src/calculations/d1.ts`: see what the operation saves.
4. `src/services.ts` and `src/routes/calculations/index.ts`: see how real dependencies reach it and how HTTP outcomes are produced.
5. `src/calculations/runs.ts`, then the tiny `src/calculation-run-workflow.ts` adapter.
6. Python `framework.py`, `types/ex_ante_vol.py`, then `runtime.py` and `storage.py`.
7. Finally, read the full ingestion path and root `src/index.ts`. Starting at the root exposes nearly every concern at once and is a poor introduction.

## Suggested sequence of improvements

### First: repair behavior without reorganizing everything

Fix unknown Workflow status handling and ambiguous creation. Agree on expected/retryable/unexpected error contracts in both Python runtimes. Replace fallible `Effect.promise` calls, validate engine responses, and correct the missing-data status mismatch. Add focused regression tests alongside each fix.

**Done when:** temporary infrastructure failures have an explicit bounded recovery path, and monitoring failures cannot release active ownership.

### Second: make one feature easy for you to maintain

Use calculations as the exemplar. Clarify contracts/store/operations naming, make execution inputs explicit, simplify its dependency assembly, and extract only the repeated HTTP execution mechanics. Keep route behavior and SQL protection covered while doing this.

**Done when:** you can explain “start a calculation” from input through durable execution and persistence without reconstructing unrelated modules.

### Third: improve the everyday development loop

Fix README links, consolidate architecture authority, add the maintainer/Effect walkthrough, declare tool versions, build the app during PR checks, and provide a fixture-backed local mode. Add a few targeted runtime and browser tests.

**Done when:** a returning maintainer can run a representative path and make a small change using one documented route through the code.

### Later, as requirements justify it

Stronger historical reproducibility, input version retention, frequent reconciliation, raw retention, result provenance, capacity measurement, browser decoding optimization and deployment isolation. These are real requirements to weigh; they should not become prerequisites for understanding the current project.

Avoid a wholesale rewrite, a universal repository abstraction, converting all pure helpers to Effect, introducing a service for every function, or extracting every large Svelte file into tiny pieces. The most valuable changes here make ownership and failure behavior explicit while reducing the amount a reader must hold in their head.
