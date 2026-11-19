# One Python service exposing uniform operations

Normalization and calculations will share one Python package and container,
replacing separate processor and engine services. Python modules expose operations
through a uniform contract and dispatcher, allowing normalization to be registered
like a calculation and new operations to follow the same pattern.

TypeScript registers the workflow-facing steps and Effect orchestrates their
execution under Cloudflare Workflows durability. Python executes the requested
operation; it does not own workflow sequencing, scheduling, or dependency waits.
Python operations define their parameter contracts with Pydantic. Exported schemas
generate TypeScript contracts used by explicit workflow-step registrations. A
generated invocation SDK is optional; generated specification types are required.
