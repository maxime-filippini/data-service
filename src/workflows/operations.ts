import { Effect } from "effect";

import {
  type Subject,
  WorkflowError,
  type WorkflowSpec,
} from "$/workflows/contracts";
import { inspectWorkflow } from "$/workflows/inspect";
import { StepRegistry, stepCatalog } from "$/workflows/registry";
import { Workflows } from "$/workflows/store";
import { validateWorkflowSpec } from "$/workflows/validate";

/**
 * Application operations shared by the management API, the app's API and
 * the app's pages. Specifications are validated against the step registry
 * before anything is written.
 */

/** Fail with every registry issue of a specification, or succeed. */
const requireValid = Effect.fn("Workflows.validate")(function* (
  spec: WorkflowSpec,
) {
  const registry = yield* StepRegistry;
  const issues = validateWorkflowSpec(spec, registry);
  if (issues.length > 0)
    return yield* new WorkflowError({
      kind: "invalid",
      message: "The workflow specification is invalid",
      issues,
    });
});

/** Validate and save a new definition. */
export const createWorkflow = Effect.fn("Workflows.create")(function* (
  spec: WorkflowSpec,
  id: string,
  now: string,
) {
  yield* requireValid(spec);
  const workflows = yield* Workflows;
  return yield* workflows.create(id, spec, now);
});

/**
 * Validate and atomically replace a whole definition. An invalid
 * specification changes nothing.
 */
export const replaceWorkflow = Effect.fn("Workflows.replace")(function* (
  id: string,
  spec: WorkflowSpec,
  now: string,
) {
  yield* requireValid(spec);
  const workflows = yield* Workflows;
  return yield* workflows.replace(id, spec, now);
});

/** A definition with its ordered steps' connections, and its assignments. */
export const inspectWorkflowById = Effect.fn("Workflows.inspect")(function* (
  id: string,
) {
  const workflows = yield* Workflows;
  const registry = yield* StepRegistry;
  const [workflow, assignments] = yield* Effect.all([
    workflows.get(id),
    workflows.listAssignments({ workflowId: id }),
  ]);
  return { inspection: inspectWorkflow(workflow, registry), assignments };
});

/** The definitions assigned to one subject. */
export const subjectAssignments = (subject: Subject) =>
  Workflows.use((workflows) => workflows.listAssignments({ subject }));

/** Every registered step type and contract. */
export const catalog = StepRegistry.use((registry) =>
  Effect.succeed(stepCatalog(registry)),
);
