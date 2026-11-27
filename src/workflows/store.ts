import { Context, type Effect } from "effect";

import type {
  Subject,
  SubjectKind,
  WorkflowAssignment,
  WorkflowDefault,
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
export class WorkflowStore extends Context.Service<
  WorkflowStore,
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
     * while the definition has assignments or is a default.
     */
    readonly replace: (
      id: string,
      spec: WorkflowSpec,
      now: string,
    ) => Effect.Effect<WorkflowDefinition, WorkflowError>;
    /** Delete the definition, its assignments and its default links. */
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
    /** The defaults, by subject kind then definition name. */
    readonly listDefaults: (
      kind?: SubjectKind,
    ) => Effect.Effect<readonly WorkflowDefault[], WorkflowError>;
    /**
     * Make a definition a default for new subjects of its scope. Idempotent;
     * `invalid` for another kind, `not_found` for an unknown definition.
     * Existing subjects are not assigned.
     */
    readonly addDefault: (
      kind: SubjectKind,
      workflowId: string,
      now: string,
    ) => Effect.Effect<WorkflowDefault, WorkflowError>;
    /** Stop assigning a definition to new subjects; assignments stay. */
    readonly removeDefault: (
      kind: SubjectKind,
      workflowId: string,
    ) => Effect.Effect<void, WorkflowError>;
    /**
     * Assign the kind's defaults to every existing subject that lacks them,
     * enabled, and return the added assignments. Existing assignments,
     * including disabled ones, are left as they are, so applying again adds
     * nothing.
     */
    readonly applyDefaults: (
      kind: SubjectKind,
      now: string,
    ) => Effect.Effect<readonly WorkflowAssignment[], WorkflowError>;
  }
>()("data-service/WorkflowStore") {}
