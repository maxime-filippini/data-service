# Simplify the data service around explicit workflows

## Problem Statement

The sole maintainer needs to understand and own a service whose only active production
use is automatic market-data downloading. Following that operation currently requires
understanding separate dispatch, ingestion, processing, and calculation mechanisms,
inconsistent retry behavior, and two Python services. A dispatch can finish before
its data is ready. Calculations use independently timed schedules rather than explicit
data dependencies. Local execution does not show the complete real data path.

The maintainer wants a CRUD-oriented service for assets, portfolios, and workflow
definitions, with visible data flow and one understandable execution model. Preserving
unused calculation APIs is less important than reducing concepts and enabling reliable
local exploration.

## Solution

Store whole workflow specifications as data. Register executable operations in code,
compose them through explicit input/output references, and execute the supplied step
order using Effect inside Cloudflare Workflows. Each scheduled definition runs once
for each assigned asset or portfolio. One Python service exposes uniformly described
normalization and calculation operations.

Expose configuration, execution, and dataset retrieval through authenticated APIs.
Provide a read-only visual workflow and run view. Supply a fixture-based local command
that uses the same executor, step implementations, and Python operations to produce
inspectable datasets without live credentials. Retire the orchestration this replaces.

## User Stories

1. As the maintainer, I want to create an asset identified by its symbol, so that instrument identity is independent of available datasets.
2. As the maintainer, I want to list, retrieve, edit, disable, and delete asset configuration through the API, so that I can manage the download universe.
3. As the maintainer, I want to create portfolios referring to registered assets, so that holdings have a clear identity.
4. As the maintainer, I want one dated holdings snapshot to represent constant holdings, so that simple portfolios stay simple.
5. As the maintainer, I want successive dated snapshots, so that calculations can account for holdings changes.
6. As the maintainer, I want to submit an entire workflow specification at once, so that authoring does not require an interactive builder.
7. As the maintainer, I want to retrieve and replace complete specifications, so that I can review and edit them as data.
8. As the maintainer, I want a step catalog with parameter and input/output contracts, so that I know what can be composed.
9. As the maintainer, I want invalid step types, parameters, and bindings rejected before execution, so that malformed definitions do not create avoidable failed runs.
10. As the maintainer, I want the ordered list to determine execution order, so that reading the definition explains execution.
11. As the maintainer, I want steps to reference any earlier output, so that I can reuse and combine intermediate results without a graph scheduler.
12. As the maintainer, I want workflows assigned to sets of assets or portfolios, so that I reuse one definition rather than copy it.
13. As the maintainer, I want defaults applied when subjects are created, so that standard processing requires little administration.
14. As the maintainer, I want changes to defaults to affect existing subjects only explicitly, so that changing defaults does not silently change their behavior.
15. As the maintainer, I want individual assignments disabled, so that I can pause one subject without editing the shared definition.
16. As the maintainer, I want daily whole-hour UTC schedules owned by definitions, so that schedule changes are data changes.
17. As the maintainer, I want one run per assigned subject, so that one asset's failure is isolated from others.
18. As the maintainer, I want manual execution and reruns from the beginning, so that I can inspect and recover work without waiting for tomorrow.
19. As the maintainer, I want one active run per assignment, so that repeated dispatch does not overlap that assignment's work.
20. As the maintainer, I want only the latest missed occurrence caught up, so that downtime does not create a historical backlog.
21. As the maintainer, I want explicit dated dependency checks, so that portfolio operations do not silently assume that an earlier scheduled download succeeded.
22. As the maintainer, I want dependency checks to wait within a bound and report missing inputs, so that late data has an understandable outcome.
23. As the maintainer, I want dependency checks never to launch other workflows, so that the definition describes the work being performed.
24. As the maintainer, I want small lists and metadata passed directly between steps, so that ordinary values do not require file management.
25. As the maintainer, I want large outputs persisted as artifacts, so that TypeScript and Python can exchange data without relying on shared memory.
26. As the maintainer, I want explicit publication of datasets, so that temporary intermediate output is distinguishable from consumer-facing results.
27. As a dataset consumer, I want lookup by dataset name and subject, so that I do not need to know temporary storage locations.
28. As the maintainer, I want temporary artifacts expired after 30 days, so that cleanup needs no application scheduler or artifact index.
29. As the maintainer, I want published datasets unaffected by temporary cleanup, so that consumers retain their current data.
30. As the maintainer, I want a uniform Python module contract, so that adding normalization or numerical operations follows one pattern.
31. As the maintainer, I want TypeScript contracts generated from Pydantic schemas, so that the language boundary does not require hand-maintained duplicate definitions.
32. As the maintainer, I want temporary failures retried and terminal failures explained, so that recovery behavior is consistent across steps.
33. As the maintainer, I want active runs to keep their original step sequence when definitions change, so that checkpoints stay meaningful.
34. As the maintainer, I want current-state inputs without a historical versioning system, so that implementation stays small.
35. As the maintainer, I want to inspect a workflow's connections, parameters, and run outcomes visually, so that I can understand the system without reconstructing it from logs.
36. As the maintainer, I want fixture execution through the real TypeScript and Python code, so that I can learn and debug the complete data path locally.
37. As the maintainer, I want existing automatic downloads and retained data preserved during cutover, so that simplification does not lose the capability currently in use.
38. As the maintainer, I want superseded services and execution paths removed, so that I only have one model to learn afterward.
39. As the maintainer, I want configuration deletion to retain results and history while respecting active runs and holdings references, so that CRUD operations have predictable boundaries.

## Implementation Decisions

### Settled architecture

- Assets are identified by symbol. Dataset identity combines dataset name with an asset symbol or portfolio ID. Dataset membership is not asset identity. Preserve provider-qualified symbols already used by the service; do not invent a new instrument identifier system.
- Portfolios retain dated holdings. Calculations determine the needed interval and use the snapshot effective at its start plus subsequent changes. Preserve existing numerical conventions instead of redefining finance formulas as part of this refactor.
- D1 stores assets, portfolios/holdings, workflow definitions, defaults, assignments, run records, and publication metadata. Workflow steps are JSON in a text column; searchable identity and scheduling fields are ordinary columns.
- Definitions declare subject kind, name, enabled status, daily UTC hour, and an ordered list of uniquely identified steps. Assignments are separate and unique per definition/subject. Definition scope cannot be changed while assignments exist.
- Default assignments are created with a new subject. Changing defaults affects future subjects; an explicit idempotent apply operation adds missing assignments to existing subjects without re-enabling deliberately disabled ones.
- A TypeScript registry defines each step's identity, compatible subject kinds, parameter schema, input/output schemas, and implementation. Effect implements orchestration and dependency injection. Cloudflare Workflows supplies durable checkpoints and waits; Effect alone is not the persistence layer.
- Input bindings are either literal values or references to a named run-context field or named output of an earlier step. There are no expressions, arbitrary property traversal, forward references, loops, or conditional branches. Named outputs may be reused by multiple steps. This is a DAG with an explicitly supplied execution order, not an inferred graph schedule.
- Saving validates unique IDs, known types, scopes, parameter schemas, required input names, reference existence, and compatible declared contracts. Execution validates resolved inputs and returned outputs. Compatibility uses explicit registered contract identities and schema validation, not a general JSON Schema subtyping engine.
- One run executes for one assigned subject. Different assignments may run concurrently; steps within a run execute sequentially. A terminal step failure ends that run.
- Capture the complete definition once when execution starts and retain it for that active execution. Definition edits affect subsequent executions. Ordinary small step outputs are durable checkpoint results, including JSON returned by Python through the TypeScript caller. Do not persist every value as an R2 file or build a second checkpoint database.
- Holdings and datasets are current-state inputs when their steps read them. Completed step results may be reused during durable replay; current-state does not mean re-running completed steps. No dataset pinning or historical reproduction guarantee is required.
- Python exposes a uniform operation registry and dispatcher in one package/container. Normalization is an operation alongside calculations. Pydantic describes contracts; exported schemas generate TypeScript specification contracts at development/build time. Runtime validation remains required. Python does not sequence workflows or own scheduling/retries.
- Python calls receive resolved inputs and run/step execution identity. A response may be small JSON or an artifact reference. Repeated calls after an uncertain response must be safe; output locations and side effects must tolerate retries. There is no exactly-once promise across HTTP.
- Large raw/Parquet outputs are temporary artifacts under a dedicated run namespace in R2. Artifact references carry storage identity and format/schema information; only validated internal references reach storage adapters. Secrets and arbitrary filesystem paths are not workflow parameters.
- Publication creates an independently stored current dataset and records its subject, dataset name, processing date, producing workflow/run, and relevant metadata. It must not leave the published dataset pointing into expiring temporary storage. Preserve stable asset dataset locations used by existing consumers. A failed transformation must leave the previous publication intact.
- No exclusive publisher constraint is added. The maintainer is responsible for avoiding conflicting workflows writing the same dataset. Publication checks must match the current publication's producer and processing date, not merely an unrelated successful run.
- Temporary run artifacts expire through an R2 lifecycle rule after 30 days by object age. Published datasets and pre-existing retained raw history are excluded. No D1 cleanup index, cleanup manifest, scheduled cleanup workflow, or reference counting is introduced. An unusually long active run is not protected from lifecycle expiration.
- Preserve existing management authentication and app access controls. Reuse shared application operations rather than introduce separate business logic for management and app routes.

### Concrete defaults for implementation review

These details complete the agreed model; they are proposed synthesis defaults rather than additional interview decisions.

- Scheduled processing date is the UTC calendar date of the selected due occurrence. Manual runs default to today's UTC date and accept an explicit date. Dependency inputs can reference that date or a literal date. There is no date expression language initially.
- The shared hourly trigger selects the latest due occurrence and dispatches enabled assignments. Atomic per-assignment occurrence claims prevent duplicate scheduled dispatch. An active assignment causes a new occurrence to be recorded as skipped; old missed occurrences are not replayed. A disabled subject or definition does not dispatch. Manual execution requires an enabled assignment and definition; explicit re-enabling is the initial override mechanism.
- Run submission returns an asynchronous run identifier and status. Capture claims before launching a deterministically identified platform instance. Reconcile uncertain launches against that identity without launching duplicates. An unavailable status lookup is not evidence that an instance is absent and must not release an active claim.
- Persist statuses sufficient to distinguish queued, running, waiting for inputs, completed, failed, and skipped, with step-level errors and publication references. Keep run records as operational history; do not duplicate all checkpoint payloads in D1. Deleted configuration must not cascade-delete run history, whose subject identity remains interpretable.
- Registry-owned retry policy initially permits three retries with exponential backoff for transient network/storage/service failures. Invalid parameters, unknown steps, incompatible outputs, and deterministic domain errors are terminal. Python failures use an explicit error contract instead of successful HTTP responses hiding failed work. Wait steps use durable waits and rechecks, with a default two-hour timeout configurable in the step; the deadline must not reset on replay.
- A dependency check requires both upstream success for the requested workflow, subject, and processing date and a matching current publication. It reports missing subjects on timeout and never launches upstream work. A successful refresh on a non-trading day can qualify; this is not a market-calendar completeness guarantee. The calculation still validates the data coverage needed for its mathematics.
- Dataset metadata is updated only after the dataset write succeeds. A retry can reconcile a write whose metadata update failed. Storage/database publication is not advertised as a cross-service transaction, and concurrent publishers remain outside enforced guarantees.
- Prefer a simple artifact descriptor shared by TypeScript and Python, with a format/schema discriminator and storage location resolved by adapters. Small output lists are returned directly; enforce the platform's checkpoint size limits. Local adapters map artifact identities to files in a controlled output directory.

### API and app surface

- Asset and portfolio APIs support creation, listing, retrieval, updates, and deletion. Holdings operations retain dated snapshots and validate asset references.
- Workflow APIs create a full specification with POST, retrieve/list it, and replace it atomically with PUT. An invalid replacement leaves the previous definition intact. Execution settings are part of the complete definition; step-by-step editing endpoints are unnecessary.
- Assignment/default APIs attach, list, disable, remove, and explicitly apply defaults to existing subjects. Removal is blocked while affected runs are active. Asset deletion is blocked while any portfolio holdings reference it. Removing definitions/subjects removes relevant assignments/default links but retains run history and published data.
- Run APIs start an assignment for a processing date, list/filter runs, retrieve step outcomes, and rerun from the beginning as a new run. They do not implement arbitrary-step resume or synchronous calculations.
- Dataset APIs list a subject's publications, return publication metadata, and retrieve its current data without exposing temporary run paths. Dataset retrieval remains possible through retained subject identity after configuration deletion. Preserve existing data formats where they are consumer contracts.
- The app provides read-only definition details with ordered steps, visible input connections, parameters, scope, assignments, and schedule; run lists/detail show waiting, progress, errors, outputs, and dataset links. Data comes from the same specification and run APIs. A drag-and-drop builder and app-based executable code authoring are excluded.

### Initial workflows and migration

- Deliver an asset workflow that downloads provider JSON in Effect, normalizes it through Python, and explicitly publishes end-of-day prices.
- Deliver a portfolio workflow that loads required dated holdings, checks upstream asset dataset success, calls the existing ex-ante volatility operation with explicit dataset references, and publishes portfolio volatility. It demonstrates both scopes without depending on feature-branch returns work. Preserve baseline numerical tests and behavior.
- Consolidate Python storage/configuration and operation dispatch, remove the separate processor container, and expose the same operation entry points to local execution.
- Base implementation on develop. Inventory and migrate existing symbol registrations into assets, retaining provider/download settings and existing symbols. Seed the standard download definition, defaults, and assignments from the current enabled universe and schedule. Preserve real portfolio holdings and stored datasets. Stop automatic creation of synthetic single-asset portfolios; remove legacy ones only when positively identified as generated and unused.
- The service only actively uses downloads, so unused saved-calculation, synchronous, heterogeneous batch, and arbitrary-cron surfaces may be retired deliberately. Inspect existing configuration during migration; disable rather than silently translate unsupported schedules. Preserve unrelated retained data and document the breaking API changes.
- Cut over without running old and new download dispatchers simultaneously. Verify successful publication and recovery in the new path, then remove superseded queues, dispatch/status machinery, bindings, routes, UI screens, and duplicated Python infrastructure. Preserve atomic claims and output validation. Keep a rollback procedure until cutover is verified.
- Provide a deterministic fixture command that sets up subjects and definitions, runs the asset and portfolio workflows through their real registered operations, and writes raw/intermediate/published outputs plus readable run results. Both languages share a local storage adapter. It must require neither live-provider credentials nor real R2. Keep a short guide showing how to add a Python-backed step and an Effect-only step.

## Testing Decisions

- Confirmed primary seam: the public application/API boundary driving a fixture-backed execution scenario. Create subjects, submit complete definitions, run the same executor and real Python operations, and assert run outcomes and published datasets. Avoid mocking each internal module or asserting private call sequences. This is the highest useful seam for the maintainer's understanding goal.
- Reuse the existing real-migration SQLite D1 test adapter, request-level Hono tests, dependency-injected Effect services, and narrow durable Steps adapter. Extend the latter only as needed for durable waits; do not create a separate local workflow engine with different semantics.
- Keep focused Python numerical and transformation tests, including existing injected data loaders and storage test doubles. They verify math and schema behavior independently from the orchestration acceptance scenario.
- Cross-language acceptance runs the real Python dispatcher through its HTTP boundary with shared local storage. Generated contract checks detect stale exports and incompatible responses; TypeScript compile-time types do not replace runtime validation.
- Successful asset scenario: fixture download, raw artifact, normalization, publication, dataset lookup, and readable step outputs. Successful portfolio scenario: dated holdings including an effective starting snapshot, upstream success checks, real numerical operation, and independent publication. Verify expected rows/values and metadata rather than internal architecture.
- Invalid definitions cover duplicate IDs, missing/forward/self references, unknown types/outputs, wrong scopes, incompatible bindings, and malformed params; failed replacement must preserve the old definition. No separate graph cycle algorithm needs tests when backward-only validation already prevents cycles.
- Scheduling tests use a controlled clock for UTC hours, midnight/date boundaries, duplicate ticks, latest-only catch-up, disabled assignments, and overlapping manual/scheduled runs. Exercise atomic claims with real SQL and uncertain instance-launch/status outcomes.
- Dependency scenarios cover delayed readiness, wrong-date success, success without a matching publication, timeout, missing subjects, and a non-trading-day refresh. Assert no upstream work is launched by dependency checks.
- Failure scenarios include a transient Python/storage failure followed by recovery, a terminal domain error, a lost Python response followed by a repeated invocation, and a publication metadata failure after an object write. Verify safe outputs and truthful status; do not claim general exactly-once execution.
- Editing/deletion tests verify an active run retains its sequence, subsequent runs observe replacement specs, defaults do not retroactively reassign subjects, holdings prevent asset deletion, and history/data survive allowed configuration deletion.
- Artifact tests verify publication independence from temporary files and lifecycle rule scope/duration. Do not wait 30 days in a test or treat lifecycle expiration as precise. Verify old retained raw data is outside the rule.
- App checks verify the rendered sequence, input connections, waiting/error states, and dataset references using the API's actual shape; keep them focused on visible behavior.
- A separate Cloudflare integration smoke test must verify actual checkpoint replay, durable wait/recheck, transient failure recovery, and TypeScript-to-container delivery. A local callback-only Steps adapter is not evidence of platform durability. Perform this in an isolated test environment before production cutover.
- This specification-only change needs documentation formatting, link/example consistency, and branch-base checks, not a full application test run.

## Out of Scope

- A visual workflow builder, incremental step-edit API, user-authored executable code, expressions, graph scheduling, parallel steps, conditionals, loops, or upstream auto-triggering.
- Historical dataset pinning, exact reproduction, a version catalog, manual resume from arbitrary steps, and guarantees against different workflows publishing to the same dataset.
- Minute-resolution schedules, arbitrary user cron, independent subject-owned schedules, and replaying every missed occurrence.
- Synchronous calculations, heterogeneous calculation batches, and preservation of unused saved-calculation API shapes.
- A new instrument taxonomy, finance-model redesign, new calculation algorithms, automatic market-calendar completeness guarantees, or a frontend/platform rewrite.
- A scheduled cleanup workflow, per-artifact retention index, reference counting, or deletion of existing retained raw history.
- Implementation, deployment, production migration, or unrelated feature-branch changes as part of writing this specification.

## Further Notes

The governing decisions are the ADRs for serialized workflows, current-state inputs,
the uniform Python service, and R2 artifact lifecycle. The glossary describes the
agreed target model; the earlier glossary is retained as historical reference.
The companion workflow examples illustrate references and publication, not a second
normative API. The existing simplification review was written against a feature
branch; this specification is based on develop and must not inherit those commits.

Remaining review choices are the concrete defaults explicitly marked above, particularly
retry counts, dependency timeout, and manual-run enablement. They do not reopen the
settled architecture. The maintainer confirmed the API/fixture acceptance seam,
focused numerical tests, and separate Cloudflare durability smoke test. The
maintainer also confirmed publication to the repository GitHub Issues with the
ready-for-agent label. That triage state does not authorize a production deployment.
