// Workflow definitions, assignments and the step catalog as the API returns
// them. This file imports only the import-free `subjects.ts`, so the app can
// import its types directly.

import type { SubjectKind, SubjectView } from "./subjects";

export type { SubjectKind, SubjectView } from "./subjects";

/** A literal value or a reference to run context or an earlier output. */
export type BindingView =
  { readonly value: unknown } | { readonly ref: string };

/** One configured step, as submitted. */
export interface StepSpecView {
  readonly id: string;
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly inputs: Readonly<Record<string, BindingView>>;
}

/**
 * A saved, complete workflow specification. `steps` is the execution order.
 * PUT replaces all of it at once.
 */
export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly scope: SubjectKind;
  readonly enabled: boolean;
  readonly schedule: { readonly hourUtc: number };
  readonly steps: readonly StepSpecView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** List projection of a definition, without its steps. */
export interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly scope: SubjectKind;
  readonly enabled: boolean;
  readonly schedule: { readonly hourUtc: number };
  readonly stepCount: number;
  readonly assignmentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One definition assigned to one subject. Disabling it pauses that subject
 * without changing the shared definition. `schedule` and `workflowEnabled`
 * are the definition's: the assignment is dispatched daily at that UTC hour
 * while it, its definition and its subject are enabled.
 */
export interface WorkflowAssignment {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly workflowEnabled: boolean;
  readonly schedule: { readonly hourUtc: number };
  readonly subject: SubjectView;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A definition assigned automatically to every new subject of its kind.
 * Existing subjects only get it when defaults are applied explicitly.
 */
export interface WorkflowDefault {
  readonly subjectKind: SubjectKind;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly workflowEnabled: boolean;
  readonly schedule: { readonly hourUtc: number };
  readonly createdAt: string;
}

/** A JSON Schema (draft 2020-12) object. */
export type JsonSchemaView = Readonly<Record<string, unknown>>;

/** A registered contract identity and the schema its values satisfy. */
export interface ContractView {
  readonly id: string;
  readonly description: string;
  readonly schema: JsonSchemaView;
  readonly accepts?: readonly string[];
}

/** One named input or output of a step type and its contract identity. */
export interface PortView {
  readonly name: string;
  readonly contract: string;
  readonly description: string;
}

/** A registered step type: what a workflow step can be. */
export interface StepTypeView {
  readonly type: string;
  readonly description: string;
  /** The definition scopes it can be used in. */
  readonly scopes: readonly SubjectKind[];
  readonly params: JsonSchemaView;
  readonly inputs: readonly PortView[];
  readonly outputs: readonly PortView[];
}

/**
 * The step catalog: every registered step type, the contracts their inputs
 * and outputs use, and the run-context fields a reference can name.
 */
export interface StepCatalog {
  readonly stepTypes: readonly StepTypeView[];
  readonly contracts: readonly ContractView[];
  readonly context: readonly {
    readonly field: string;
    readonly description: string;
    /** Contract identity by definition scope. */
    readonly contracts: Readonly<Record<SubjectKind, string>>;
  }[];
}

/** Where one step input's value comes from, resolved for display. */
export type InputSource =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "context"; readonly ref: string; readonly field: string }
  | {
      readonly kind: "output";
      readonly ref: string;
      readonly step: string;
      readonly output: string;
    };

/** One step input with its contract and source. */
export interface StepInputDetail {
  readonly name: string;
  /** Null when the step type or input is not registered. */
  readonly contract: string | null;
  readonly source: InputSource;
}

/** One step output with the later inputs that use it. */
export interface StepOutputDetail {
  readonly name: string;
  readonly contract: string;
  readonly description: string;
  readonly usedBy: readonly { readonly step: string; readonly input: string }[];
}

/** One step of a definition, in order, with its connections. */
export interface StepDetail {
  /** 1-based position in the execution order. */
  readonly position: number;
  readonly id: string;
  readonly type: string;
  /** Null when the step type is no longer registered. */
  readonly description: string | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly inputs: readonly StepInputDetail[];
  readonly outputs: readonly StepOutputDetail[];
}

/**
 * A saved definition with what the step registry adds to it for reading:
 * each step's description, each input's contract and source, and the later
 * inputs that use each output. Built on request, never stored.
 */
export interface WorkflowDetail {
  readonly workflow: WorkflowDefinition;
  readonly steps: readonly StepDetail[];
}
