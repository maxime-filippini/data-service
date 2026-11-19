# Serialized sequential workflows with code-owned steps

The service is maintained by one developer who needs to understand and compose
its data operations. Workflow definitions will be pure serialized data describing
an ordered sequence of configured steps; executable step types will be explicitly
registered in version-controlled TypeScript, with implementations using Effect or
calling Python. A TypeScript executor will interpret these definitions, allowing
later visual composition without introducing user-authored executable code.
Input references form a DAG, but the supplied list fixes execution order. Only
references to earlier steps are allowed, so cycles are impossible after reference
validation. There is no graph scheduler, parallel execution, conditional branching,
or looping.

The web workflow builder is deferred. Each workflow definition owns its schedule
and is assigned to assets or portfolios. Defaults create individual assignments
when an object is created; changing defaults does not retroactively change
existing assignments without an explicit operation.

Dependencies are explicit steps that check upstream success, wait within a
bounded window, and fail if the requirement remains unmet. They do not trigger
upstream workflows. Checks may inspect execution records or published manifests;
the required processing date is an explicit parameter of the success check.

Each scheduled occurrence creates one run per assigned object. Cloudflare
Workflows owns durable execution, with TypeScript dispatching registered steps.
Only one run per workflow assignment may be active at a time.

Workflow definitions are stored in D1, with ordered steps and their heterogeneous
parameters serialized as JSON in a TEXT column. Registered step schemas validate
parameters at runtime. Ordinary columns hold identity, scope, and scheduling
fields.

Steps pass artifact IDs or references to later steps rather than embedding whole
datasets. Larger artifacts live in R2; definitions and run records live in D1.
Input wiring uses literals and explicit references to earlier outputs or run
context, without an expression language.

After scheduler downtime, only the latest due occurrence is started; older
missed occurrences are not replayed. The run context carries its processing date.

The initial API supports creating assets and portfolios, and creating, retrieving,
and replacing complete workflow specifications. The app provides a read-only
definition and execution view; incremental visual authoring is deferred.

Schedules are daily at a whole UTC hour, dispatched by a shared hourly Worker
trigger that checks stored schedules.
Manual recovery starts a new run from the beginning using current state;
automatic bounded retries operate within steps. Manual resume from an arbitrary
step is deferred.

There is no exclusive dataset publisher constraint. The maintainer is responsible
for avoiding workflows that overwrite each other's datasets; one-active-run
protection remains scoped to an individual workflow assignment.
