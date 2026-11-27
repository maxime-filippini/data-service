import { Effect, Schema } from "effect";

import type { AssetStore } from "$/assets/store";
import type {
  DatasetPublicationStore,
  DatasetObjectStore,
} from "$/datasets/store";
import type { MarketDataSources } from "$/market-data/sources";
import type { PythonOperations } from "$/operations/client";
import type { Portfolios } from "$/portfolios/store";
import type { RunArtifacts } from "$/workflows/artifacts";
import type { StepSpec, Subject, SubjectKind } from "$/workflows/contracts";
import type { MissingDependency } from "$/workflows/runs/contracts";
import { type Contract, dateContract, subjectContracts } from "./contract";

/**
 * One step input or output and the contract its values satisfy. Its name is
 * its key in the step type's `inputs` or `outputs`, so it is not repeated
 * here; the catalog adds it to each port it returns.
 */
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
    contract: (scope: SubjectKind) => subjectContracts[scope],
  },
  processingDate: {
    description: "The date the run performs work for (UTC calendar date)",
    contract: (_scope: SubjectKind) => dateContract,
  },
} as const satisfies Record<
  keyof RunContext,
  {
    readonly description: string;
    readonly contract: (scope: SubjectKind) => Contract<any>;
  }
>;

/** Whether a `context.<field>` reference names a run-context field. */
export const isRunContextField = (
  field: string,
): field is keyof typeof runContextFields =>
  Object.hasOwn(runContextFields, field);

/**
 * Which run and step an implementation executes, for retry-safe outputs,
 * and the workflow the run belongs to, for recording producers.
 */
export interface StepExecution {
  readonly workflowId: string;
  readonly runId: string;
  readonly stepId: string;
}

/**
 * What an implementation receives: decoded params, resolved and validated
 * inputs, the run context, and its execution identity.
 */
export interface StepRequest<P, I> {
  readonly params: P;
  readonly inputs: I;
  readonly context: RunContext;
  readonly execution: StepExecution;
}

/**
 * Why a step attempt failed. `retry` marks a transient failure (network,
 * storage, service); the executor retries it within its step policy.
 * Otherwise it is terminal (invalid input, deterministic domain error) and
 * stops the run at once.
 */
export class StepFailure extends Schema.TaggedError<StepFailure>()(
  "StepFailure",
  { retry: Schema.Boolean, message: Schema.String },
) {}

/** The services step implementations can use. */
export type StepServices =
  | AssetStore
  | Portfolios
  | MarketDataSources
  | RunArtifacts
  | PythonOperations
  | DatasetPublicationStore
  | DatasetObjectStore;

/** A durable check is either ready to produce outputs or waiting for inputs. */
export type WaitCheck<O> =
  | { readonly ready: true; readonly outputs: O }
  | { readonly ready: false; readonly missing: readonly MissingDependency[] };

/**
 * A registered, version-controlled operation a workflow step can use: its
 * identity, the scopes it runs in, its parameter schema, and its named input
 * and output contracts. `implementation` is the executable slot the executor
 * calls; a type registered without one can be authored and shown, but a
 * run reaching it fails.
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
  /** Check relationships between decoded parameters, scope and literal inputs. */
  validateConfiguration?(
    params: P,
    scope: SubjectKind,
    inputs: StepSpec["inputs"],
  ): readonly { readonly path: readonly string[]; readonly message: string }[];
  /** Method syntax keeps registrations with specific types assignable. */
  implementation?(
    request: StepRequest<P, PortValues<I>>,
  ): Effect.Effect<PortValues<O>, StepFailure, StepServices>;
  /** The executor checkpoints each check and durably sleeps between checks. */
  readonly wait?: {
    timeoutMs(params: P): number;
    check(
      request: StepRequest<P, PortValues<I>>,
      deadline: string,
    ): Effect.Effect<WaitCheck<PortValues<O>>, StepFailure, StepServices>;
  };
}

/** A transient step failure, retried within the executor's step policy. */
export const transient = (message: string) =>
  new StepFailure({ retry: true, message });

/** A terminal step failure, which stops the run. */
export const terminal = (message: string) =>
  new StepFailure({ retry: false, message });

/**
 * Treat every failure of `program` as transient, keeping its message: for
 * services whose failures are all worth retrying, such as recording run
 * outcomes.
 */
export const asTransient = <A, E extends { readonly message: string }, R>(
  program: Effect.Effect<A, E, R>,
) => Effect.mapError(program, (error) => transient(error.message));

/**
 * Treat an unexpected exception (a defect) as a transient failure: it may be
 * an outage as much as a bug.
 */
export const defectsAsTransient = <A, R>(
  program: Effect.Effect<A, StepFailure, R>,
) =>
  program.pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(
        transient(defect instanceof Error ? defect.message : String(defect)),
      ),
    ),
  );

/** Declare a step type, inferring its params, input and output types. */
export const defineStepType = <P, I extends Ports, O extends Ports>(
  stepType: StepType<P, I, O>,
): StepType<P, I, O> => stepType;
