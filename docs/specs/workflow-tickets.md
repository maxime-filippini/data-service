# Workflow implementation tickets

Status: approved and published as GitHub issues #30–#39; implementation not started.

Parent: [spec #29](https://github.com/maxime-filippini/data-service/issues/29).
Each ticket has the `ready-for-agent` label and native GitHub blocking relationships.
The parent issue is unchanged; each ticket references it in its body.

All slices use the develop-based implementation line, the agreed glossary and ADRs,
and the confirmed API/fixture test seam. Add narrow behavior beside the existing
service until cutover; remove legacy paths only after verification. Each slice
includes its necessary schema/API/app/test changes, not a separate layer project.
Concrete defaults marked proposed in the parent retain that status.

## 1. [Create assets and author inspectable workflow definitions](https://github.com/maxime-filippini/data-service/issues/30)

### Parent

https://github.com/maxime-filippini/data-service/issues/29

### What to build

Create an asset, submit a complete workflow specification, assign it to the asset, and inspect its ordered steps and bindings in the app. Introduce the new configuration surface alongside the working downloader.

### Acceptance criteria

- [ ] Authenticated asset CRUD uses symbol identity without dataset identity or automatic synthetic portfolios; preserve existing management and app access controls.
- [ ] Workflow POST, list/detail, and atomic full-spec PUT persist scope, enabled state, daily UTC hour, and ordered steps; expose registered step contracts through a catalog.
- [ ] Reject duplicate step IDs, unknown types, malformed parameters, incompatible subject/input contracts, and missing/self/forward output references. Invalid replacement preserves the saved definition.
- [ ] Explicit assignment APIs list, add, disable, and remove unique definition/subject associations. Scope changes with assignments are rejected.
- [ ] The read-only app displays assets, definitions, assignments, parameters, ordered steps, and visible reference connections from shared application operations.
- [ ] Use request-level tests with real-migration SQLite for round trips, validation, and access control. Register the actual download step contract; execution is delivered by the subsequent manual-download ticket. Keep legacy routes operational.

### Blocked by

None — can start immediately.

## 2. [Run an asset download manually and inspect durable step outputs](https://github.com/maxime-filippini/data-service/issues/31)

### Parent

https://github.com/maxime-filippini/data-service/issues/29

### What to build

Start an assigned asset workflow through the API, execute its Effect download step under Cloudflare Workflows, and inspect the run and raw artifact. Supply the first fixture-driven local command using the same executor.

### Acceptance criteria

- [ ] Manual execution returns an asynchronous run ID, accepts a processing date defaulting to today UTC, and requires enabled configuration. Rerun creates a new run from the beginning.
- [ ] Execute the supplied list sequentially; resolve literals/context/prior outputs, validate resolved values, and return small named outputs through the durable Steps adapter. Do not add an alternate local sequence interpreter.
- [ ] Capture the definition once for an active execution. Atomic claims allow one active run per assignment; deterministic platform identities reconcile uncertain launches. Unknown instance status never releases a claim.
- [ ] Download real provider data through the existing provider integration or fixture data through an injected adapter; persist large raw data under the run namespace and checkpoint its reference. Enforce small-output size bounds.
- [ ] Transient failures use bounded retries and terminal failures stop the run with diagnostics. Repeated writes tolerate retries. Existing authentication and raw-data validation remain effective.
- [ ] API/app expose queued/running/completed/failed/skipped runs and step outcomes. Active runs block affected deletion; allowed configuration deletion retains interpretable run history.
- [ ] A documented local invocation creates the configuration through application APIs, runs the real download step against fixtures, and produces inspectable local artifacts without live credentials. Verify replay and overlapping submission policies through the existing test seams.

### Blocked by

- [#30: Create assets and author inspectable workflow definitions](https://github.com/maxime-filippini/data-service/issues/30)

## 3. [Normalize and publish an asset dataset through the uniform Python service](https://github.com/maxime-filippini/data-service/issues/32)

### Parent

https://github.com/maxime-filippini/data-service/issues/29

### What to build

Extend the asset workflow to download, normalize in Python, and publish end-of-day prices retrievable by dataset and asset. Demonstrate the entire path locally and expose the dataset in the app.

### Acceptance criteria

- [ ] Introduce the uniform Python operation contract/dispatcher with normalization as the first operation, sharing storage/settings code where needed while keeping legacy callers working until cutover.
- [ ] Export Pydantic schemas and generate TypeScript contracts used by explicit registrations; validate requests and responses at runtime and detect stale generated contracts.
- [ ] The TypeScript step calls the real Python HTTP operation with resolved artifact references and stable run/step identity. Python returns a small JSON output containing a Parquet artifact reference.
- [ ] Explicit publication writes a dataset independently of temporary artifacts and records producer, subject, dataset, and processing date. Preserve stable existing asset consumer locations; failed transformation leaves previous data intact.
- [ ] Dataset APIs list metadata and retrieve current data by dataset/subject; the app links run outputs to the published dataset. Retained data remains retrievable after allowed configuration deletion.
- [ ] Configure a 30-day R2 lifecycle rule only for temporary run objects; exclude published datasets and retained historical raw data. Do not add cleanup scheduling or publisher exclusivity.
- [ ] Extend the fixture command through real Python HTTP and shared local storage. Verify normalized contents, metadata, publication independence, retry-safe invocation after lost responses, and reconciliation after a metadata-write failure.

### Blocked by

- [#31: Run an asset download manually and inspect durable step outputs](https://github.com/maxime-filippini/data-service/issues/31)

## 4. [Dispatch daily workflows and manage default assignments](https://github.com/maxime-filippini/data-service/issues/33)

### Parent

https://github.com/maxime-filippini/data-service/issues/29

### What to build

Give new subjects their default workflow assignments and dispatch each enabled assignment at its workflow's daily UTC hour, with visible schedule and skip outcomes.

### Acceptance criteria

- [ ] Defaults are explicit per subject kind. Creation adds default assignments; changing defaults affects only future subjects. Applying to existing subjects is idempotent and does not re-enable disabled assignments.
- [ ] The shared hourly tick dispatches the latest due daily whole-hour UTC occurrence and gives runs its processing date. Duplicate ticks cannot duplicate an assignment occurrence.
- [ ] Only the latest missed occurrence catches up. An overlapping occurrence is recorded as skipped; disabled definitions, subjects, or assignments do not dispatch.
- [ ] Manual and scheduled runs share the same claim/launch path and one-active-run rule, including ambiguous launch reconciliation.
- [ ] API/app expose defaults, assigned schedules, and scheduled/skipped run outcomes. Defaults and assignment cleanup respect active runs.
- [ ] Controlled-clock API/SQLite tests cover UTC date boundaries, downtime, duplicates, default changes, and manual/scheduled overlap. The legacy production downloader stays the active owner until cutover; exercise new dispatch in fixtures/test configuration.

### Blocked by

- [#31: Run an asset download manually and inspect durable step outputs](https://github.com/maxime-filippini/data-service/issues/31)

## 5. [Manage dated portfolios and inspect their workflow assignments](https://github.com/maxime-filippini/data-service/issues/34)

### Parent

https://github.com/maxime-filippini/data-service/issues/29

### What to build

Create and edit portfolios with constant or changing holdings through the API, attach workflow definitions, and inspect holdings and assignments in the app.

### Acceptance criteria

- [ ] Portfolio/holdings APIs use asset symbols and dated snapshots; one snapshot remains effective until the next, with asset references and existing weight constraints validated.
- [ ] Retrieve the snapshot effective at a date and the starting snapshot plus changes across an interval without redefining numerical semantics.
- [ ] Assignments enforce portfolio scope and use the shared configuration model; no subject-specific schedules are introduced. When default assignment support lands, portfolio creation uses that same mechanism.
- [ ] Read-only portfolio detail shows dated holdings and assigned definitions using the same application operations as the API.
- [ ] Deleting an asset referenced by any holdings is rejected. Portfolio deletion removes assignments but retains existing history/data and respects active-run guards whenever present.
- [ ] API/SQLite tests cover constant and changing holdings, effective-date boundaries, missing assets, invalid assignments, and reference-protected deletion. Demonstrate with fixtures rather than a numerical calculation.

### Blocked by

- [#30: Create assets and author inspectable workflow definitions](https://github.com/maxime-filippini/data-service/issues/30)

## 6. [Wait for dated asset publications in a portfolio workflow](https://github.com/maxime-filippini/data-service/issues/35)

### Parent

https://github.com/maxime-filippini/data-service/issues/29

### What to build

Run a portfolio workflow that resolves its holdings into an asset list and explicitly waits for matching upstream dataset publications, displaying what is missing and why.

### Acceptance criteria

- [ ] Register a portfolio-holdings step that stores resolved holdings as a JSON run artifact and a dependency step consuming that artifact through an explicit reference, returning its publication list as an artifact too.
- [ ] Dependency checks require the requested upstream workflow and subject to have succeeded for the input processing date and have a matching current publication; a success record alone is insufficient.
- [ ] Return named published-dataset references on success. Check only; never start upstream workflows or expose expired run artifacts as dependencies.
- [ ] Durable waiting has a configurable bounded timeout, initially two hours, and a deadline stable across replay. Timeout fails the run with the missing subjects identified.
- [ ] API/app display waiting status, missing dependencies, resumed progress, and terminal errors.
- [ ] Local scenarios run actual asset workflows to produce success/publication records, then consume them from the portfolio workflow. Test delayed readiness, wrong date, missing publication, timeout, non-trading-day processing success, and no upstream launch. Coverage completeness remains the numerical operation's responsibility.

### Blocked by

- [#32: Normalize and publish an asset dataset through the uniform Python service](https://github.com/maxime-filippini/data-service/issues/32)
- [#34: Manage dated portfolios and inspect their workflow assignments](https://github.com/maxime-filippini/data-service/issues/34)

## 7. [Calculate and publish portfolio volatility from explicit inputs](https://github.com/maxime-filippini/data-service/issues/36)

### Parent

https://github.com/maxime-filippini/data-service/issues/29

### What to build

Complete the portfolio workflow by invoking the existing ex-ante volatility mathematics through the uniform Python service and publishing a portfolio dataset.

### Acceptance criteria

- [ ] Add the volatility operation using the same Pydantic export, generated TypeScript contracts, dispatcher, storage adapters, and explicit registration as normalization.
- [ ] Supply resolved holdings, published price references, and processing date explicitly. Preserve the baseline rule of applying effective-date weights to historical returns; do not import unfinished feature-branch returns work.
- [ ] Publish portfolio volatility through the shared publication step and retrieve it by dataset/portfolio identity. Show calculation outputs and the published dataset in the run view.
- [ ] Demonstrate small JSON outputs and artifact references crossing the Python/TypeScript boundary, with runtime validation and consistent terminal/transient error behavior.
- [ ] Extend the single fixture command to create assets and a changing-holdings portfolio, run asset publication followed by portfolio processing, and output inspectable datasets and run results.
- [ ] Retain focused numerical tests and assert expected values plus missing-data/domain failures through the cross-language acceptance scenario. Document adding one Python-backed operation and one Effect-only step.

### Blocked by

- [#35: Wait for dated asset publications in a portfolio workflow](https://github.com/maxime-filippini/data-service/issues/35)

## 8. [Verify recovery across Cloudflare checkpoints and Python delivery](https://github.com/maxime-filippini/data-service/issues/37)

### Parent

https://github.com/maxime-filippini/data-service/issues/29

### What to build

Demonstrate scheduled asset and portfolio workflows recovering from interruptions on the actual platform, with truthful run views and safe publication before migration.

### Acceptance criteria

- [ ] Provide an isolated Cloudflare smoke scenario using test data and the uniform Python service; keep it separate from fast local acceptance tests.
- [ ] Demonstrate completed-step replay, a durable dependency wait/recheck, bounded transient retry, and recovery after an uncertain Python response without duplicate or corrupted output.
- [ ] Exercise uncertain launch and status lookup, duplicate scheduled delivery, metadata failure after publication write, and preserved active-run sequence after a definition edit.
- [ ] Verify invalid input remains terminal, waiting deadlines survive replay, terminal runs release assignment claims, and manual reruns create new executions with current state.
- [ ] Assert API/app status and errors reflect the actual outcome and dataset lookup serves a valid publication. Confirm lifecycle configuration excludes published and retained raw data.
- [ ] Record reproducible execution instructions and evidence. Fix any exposed integration defects; callback-only local tests do not count as proof of Cloudflare durability. Production migration is not part of this ticket.

### Blocked by

- [#33: Dispatch daily workflows and manage default assignments](https://github.com/maxime-filippini/data-service/issues/33)
- [#36: Calculate and publish portfolio volatility from explicit inputs](https://github.com/maxime-filippini/data-service/issues/36)

## 9. [Migrate existing registrations and cut downloads over to workflows](https://github.com/maxime-filippini/data-service/issues/38)

### Parent

https://github.com/maxime-filippini/data-service/issues/29

### What to build

Move the existing automatic-download configuration to the new asset/workflow model and verify that one dispatcher owns ongoing downloads without losing data or consumer compatibility.

### Acceptance criteria

- [ ] Inventory registrations, provider/start-date settings, enabled state, schedule, portfolios, and retained data; supply an idempotent migration with a dry-run report and rollback instructions.
- [ ] Seed the download definition, defaults, and explicit assignments while retaining existing symbols/settings, real holdings, and stable asset dataset paths.
- [ ] Report unsupported unused schedules rather than silently translating them; remove generated single-asset portfolios only when positively identified and unused.
- [ ] Perform the switchover as an explicit operation with no concurrent old/new dispatch ownership. Keep the old implementation available for rollback until new-path success and recovery are verified.
- [ ] Rehearse on representative fixture/test state and verify API/app configuration and run visibility before and after migration, including configuration deletion preserving historical identities/data.
- [ ] Prepare and review the concrete production cutover before executing it under the implementation session's deployment authorization. Record successful publication and recovery before proceeding to legacy removal.

### Blocked by

- [#37: Verify recovery across Cloudflare checkpoints and Python delivery](https://github.com/maxime-filippini/data-service/issues/37)

## 10. [Remove superseded execution paths and finish the ownership guide](https://github.com/maxime-filippini/data-service/issues/39)

### Parent

https://github.com/maxime-filippini/data-service/issues/29

### What to build

Leave the maintainer with one workflow execution model, one Python service, and a short local/visual guide after verified cutover.

### Acceptance criteria

- [ ] Remove superseded download dispatch/queue/processing state machinery and unused saved-calculation, synchronous, heterogeneous batch, and arbitrary-cron surfaces once no active caller depends on them.
- [ ] Remove the separate processor container and obsolete bindings, deployment/CI configuration, and legacy app screens; retain the uniform Python service and shared application operations.
- [ ] Retain necessary migration and historical read compatibility instead of deleting stored datasets or run history. Preserve authentication, atomic claims, validation, and numerical behavior.
- [ ] Update documentation and app navigation to the final asset/portfolio/workflow vocabulary; explain one end-to-end local scenario, input/output references, failure recovery, publication, and retention.
- [ ] Run the complete fixture acceptance path, numerical tests, relevant API/app checks, generated-contract checks, and final platform smoke verification against the contracted configuration.
- [ ] Confirm no active caller or configuration requires removed paths, no temporary-artifact cleanup task was introduced, and neither a visual builder nor historical reproduction system slipped into scope.

### Blocked by

- [#38: Migrate existing registrations and cut downloads over to workflows](https://github.com/maxime-filippini/data-service/issues/38)
