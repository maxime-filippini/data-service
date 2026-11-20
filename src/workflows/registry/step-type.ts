import type { Effect, Schema } from "effect";

import type { Subject, SubjectKind } from "$/workflows/contracts";
import {
  assetSubject,
  type Contract,
  date,
  portfolioSubject,
} from "./contract";

/** One named step input or output and the contract its values satisfy. */
export interface Port {
  readonly contract: Contract<any>;
  readonly description: string;
}

/** A step type's named inputs or outputs. */
export type Ports = Readonly<Record<string, Port>>;

/** The values of a set of ports, by name. */
export type PortValues<P extends Ports> = {
  readonly [K in keyof P]: P[K]["contract"] extends Contract<infer T>
    ? T
    : never;
};

/** What every run supplies to its steps' `context.<field>` references. */
export interface RunContext {
  readonly subject: Subject;
  readonly processingDate: string;
}

/**
 * The run-context fields a reference can name, with the contract each
 * provides in a definition of the given scope.
 */
export const runContextFields = {
  subject: {
    description: "The asset or portfolio the run is for",
    contract: (scope: SubjectKind) =>
      scope === "asset" ? assetSubject : portfolioSubject,
  },
  processingDate: {
    description: "The date the run performs work for (UTC calendar date)",
    contract: (_scope: SubjectKind) => date,
  },
} as const satisfies Record<
  keyof RunContext,
  {
    readonly description: string;
    readonly contract: (scope: SubjectKind) => Contract<any>;
  }
>;

/** What an implementation receives: decoded params, resolved inputs, context. */
export interface StepRequest<P, I> {
  readonly params: P;
  readonly inputs: I;
  readonly context: RunContext;
}

/**
 * A registered, version-controlled operation a workflow step can use: its
 * identity, the scopes it runs in, its parameter schema, and its named input
 * and output contracts. `implementation` is the executable slot the executor
 * calls; a type registered without one can be authored and inspected but not
 * yet executed.
 */
export interface StepType<
  P = any,
  I extends Ports = Ports,
  O extends Ports = Ports,
> {
  readonly type: string;
  readonly description: string;
  readonly scopes: readonly SubjectKind[];
  readonly params: Schema.Codec<P, unknown>;
  readonly inputs: I;
  readonly outputs: O;
  /** Method syntax keeps registrations with specific types assignable. */
  implementation?(
    request: StepRequest<P, PortValues<I>>,
  ): Effect.Effect<PortValues<O>, unknown>;
}

/** Declare a step type, inferring its params, input and output types. */
export const defineStepType = <P, I extends Ports, O extends Ports>(
  stepType: StepType<P, I, O>,
): StepType<P, I, O> => stepType;
