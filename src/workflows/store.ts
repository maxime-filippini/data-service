import { Context, type Effect } from "effect";

import type {
  Subject,
  WorkflowAssignment,
  WorkflowDefinition,
  WorkflowError,
  WorkflowSpec,
  WorkflowSummary,
} from "./contracts";

/** Which assignments to list: one definition's, one subject's, or both. */
export interface AssignmentFilter {
  readonly workflowId?: string;
  readonly subject?: Subject;
}

/**
 * Injectable persistence for workflow definitions and their assignments.
 * The store saves what it is given: callers validate specifications against
 * the step registry first (see `operations.ts`). Each change is one atomic
 * statement, so a failed replacement leaves the saved definition intact.
 */
export class Workflows extends Context.Service<
  Workflows,
  {
    /** Every definition, by name. */
    readonly list: () => Effect.Effect<
      readonly WorkflowSummary[],
      WorkflowError
    >;
    readonly get: (
      id: string,
    ) => Effect.Effect<WorkflowDefinition, WorkflowError>;
    readonly create: (
      id: string,
      spec: WorkflowSpec,
      now: string,
    ) => Effect.Effect<WorkflowDefinition, WorkflowError>;
    /**
     * Replace the whole specification. A `conflict` when it changes the scope
     * while the definition has assignments.
     */
    readonly replace: (
      id: string,
      spec: WorkflowSpec,
      now: string,
    ) => Effect.Effect<WorkflowDefinition, WorkflowError>;
    /** Delete the definition and its assignments. */
    readonly remove: (id: string) => Effect.Effect<void, WorkflowError>;
    /** Assignments by definition name, then subject. */
    readonly listAssignments: (
      filter: AssignmentFilter,
    ) => Effect.Effect<readonly WorkflowAssignment[], WorkflowError>;
    /**
     * Assign a definition to an existing subject of its scope. `invalid` for a
     * missing subject or another scope, `conflict` if already assigned.
     */
    readonly assign: (
      workflowId: string,
      subject: Subject,
      enabled: boolean,
      now: string,
    ) => Effect.Effect<WorkflowAssignment, WorkflowError>;
    readonly setAssignmentEnabled: (
      workflowId: string,
      subject: Subject,
      enabled: boolean,
      now: string,
    ) => Effect.Effect<WorkflowAssignment, WorkflowError>;
    readonly unassign: (
      workflowId: string,
      subject: Subject,
    ) => Effect.Effect<void, WorkflowError>;
  }
>()("data-service/Workflows") {}
