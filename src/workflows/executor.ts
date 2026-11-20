import { Effect, Result, Schema, SchemaIssue } from "effect";

import type { StepSpec } from "$/workflows/contracts";
import { outputReference, parseReference } from "$/workflows/references";
import {
  DEFAULT_STEP_POLICY,
  type RunContext,
  runContextFields,
  type StepFailure,
  StepRegistry,
  type StepServices,
  type StepType,
  terminal,
  transient,
} from "$/workflows/registry";
import type { WorkflowRunParams } from "$/workflows/runs/contracts";
import { type CapturedRun, WorkflowRuns } from "$/workflows/runs/store";
import { NonRetryableStepError, type Steps } from "$/workflows/steps";

/**
 * Largest serialized outputs one step may return. Outputs are checkpointed
 * by the platform and recorded for inspection, so large data belongs in an
 * artifact whose reference is the output.
 */
export const MAX_STEP_OUTPUT_BYTES = 32 * 1024;

/** The services a run's execution needs. */
export type ExecutorServices = WorkflowRuns | StepRegistry | StepServices;

/** Runs an Effect program with the executor's services. */
export type Runner = <A, E>(
  program: Effect.Effect<A, E, ExecutorServices>,
) => Promise<A>;

/**
 * A JSON value: what a step output can be once checkpointed. Kept shallow;
 * a recursive JSON type is too deep for the platform's serializable check.
 */
type Json = {} | null;

/** A completed step's outputs, by output name. */
type StepOutputs = { readonly [name: string]: Json };

/** How a run ended, as the Workflow instance's result. */
export type ExecutionResult =
  { readonly status: "completed" } | { readonly status: "inactive" };

const now = () => new Date().toISOString();

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** Decode a value with a schema, or describe every issue. */
const decode = <A>(
  schema: Schema.Codec<A, unknown>,
  value: unknown,
): Result.Result<A, string> => {
  const result = Schema.decodeUnknownResult(schema, {
    errors: "all",
    onExcessProperty: "error",
  })(value);
  if (Result.isSuccess(result)) return Result.succeed(result.success);
  return Result.fail(
    formatIssue(result.failure.issue)
      .issues.map((issue) =>
        issue.path === undefined || issue.path.length === 0
          ? issue.message
          : `${issue.path.map(String).join(".")}: ${issue.message}`,
      )
      .join("; "),
  );
};

/**
 * Resolve one input binding: a literal as given, a run-context field, or a
 * named output of an earlier step. References are not expressions.
 */
const resolveBinding = (
  spec: StepSpec,
  name: string,
  context: RunContext,
  prior: ReadonlyMap<string, StepOutputs>,
): Result.Result<unknown, string> => {
  const binding = spec.inputs[name];
  if (binding === undefined)
    return Result.fail(`Input "${name}" has no binding`);
  if ("value" in binding) return Result.succeed(binding.value);
  const reference = parseReference(binding.ref);
  if (reference === undefined)
    return Result.fail(`Input "${name}" has an invalid reference`);
  if (reference.kind === "context")
    return Object.hasOwn(runContextFields, reference.field)
      ? Result.succeed(context[reference.field as keyof RunContext])
      : Result.fail(`Unknown run-context field "${reference.field}"`);
  const outputs = prior.get(reference.step);
  return outputs !== undefined && Object.hasOwn(outputs, reference.output)
    ? Result.succeed(outputs[reference.output])
    : Result.fail(
        `"${outputReference(reference.step, reference.output)}" is not available: no earlier step produced it`,
      );
};

/** Resolve and validate every declared input against its contract. */
const resolveInputs = (
  spec: StepSpec,
  stepType: StepType,
  context: RunContext,
  prior: ReadonlyMap<string, StepOutputs>,
) =>
  Effect.forEach(Object.entries(stepType.inputs), ([name, port]) => {
    const value = resolveBinding(spec, name, context, prior);
    if (Result.isFailure(value)) return Effect.fail(terminal(value.failure));
    const decoded = decode(port.contract.schema, value.success);
    return Result.isFailure(decoded)
      ? Effect.fail(
          terminal(
            `Input "${name}" does not satisfy contract "${port.contract.id}": ${decoded.failure}`,
          ),
        )
      : Effect.succeed([name, decoded.success] as const);
  }).pipe(Effect.map((entries) => Object.fromEntries(entries)));

/**
 * Validate returned outputs against their contracts and the size bound.
 * Only declared outputs are kept.
 */
const validateOutputs = (stepType: StepType, produced: unknown) =>
  Effect.gen(function* () {
    const values = (produced ?? {}) as Record<string, unknown>;
    const outputs: Record<string, Json> = {};
    for (const [name, port] of Object.entries(stepType.outputs)) {
      const decoded = decode(port.contract.schema, values[name]);
      if (Result.isFailure(decoded))
        return yield* terminal(
          `Output "${name}" does not satisfy contract "${port.contract.id}": ${decoded.failure}`,
        );
      outputs[name] = decoded.success as Json;
    }
    const size = new TextEncoder().encode(JSON.stringify(outputs)).length;
    if (size > MAX_STEP_OUTPUT_BYTES)
      return yield* terminal(
        `The outputs are ${size} bytes, over the ${MAX_STEP_OUTPUT_BYTES}-byte limit for step outputs; store large data as an artifact and output its reference`,
      );
    return outputs as StepOutputs;
  });

/** Decode params, resolve inputs and run the step type's implementation. */
const runImplementation = Effect.fn("Workflows.runImplementation")(function* (
  run: CapturedRun,
  spec: StepSpec,
  prior: ReadonlyMap<string, StepOutputs>,
) {
  const registry = yield* StepRegistry;
  const stepType = registry.get(spec.type);
  if (stepType === undefined)
    return yield* terminal(`Unknown step type "${spec.type}"`);
  if (stepType.implementation === undefined)
    return yield* terminal(`Step type "${spec.type}" cannot be executed yet`);
  const params = decode(stepType.params, spec.params);
  if (Result.isFailure(params))
    return yield* terminal(`Invalid params: ${params.failure}`);
  const inputs = yield* resolveInputs(spec, stepType, run.context, prior);
  const produced = yield* stepType
    .implementation({
      params: params.success,
      inputs,
      context: run.context,
      execution: { runId: run.runId, stepId: spec.id },
    })
    .pipe(
      // An unexpected exception may be an outage as much as a bug.
      Effect.catchDefect((defect) =>
        Effect.fail(
          transient(defect instanceof Error ? defect.message : String(defect)),
        ),
      ),
    );
  return yield* validateOutputs(stepType, produced);
});

const recording = <A, E extends { readonly message: string }, R>(
  program: Effect.Effect<A, E, R>,
) => Effect.mapError(program, (error) => transient(error.message));

/**
 * One attempt of one step: record its start, run it, and record its outputs
 * or failure. Repeating it is safe: outputs go to IDs fixed by the run and
 * step, and the records are upserts.
 */
const attemptStep = Effect.fn("Workflows.attemptStep")(function* (
  run: CapturedRun,
  index: number,
  prior: ReadonlyMap<string, StepOutputs>,
) {
  const spec = run.steps[index]!;
  const runs = yield* WorkflowRuns;
  const ids = { runId: run.runId, stepId: spec.id };
  yield* recording(
    runs.stepStarted({
      ...ids,
      position: index + 1,
      type: spec.type,
      now: now(),
    }),
  );
  const outputs = yield* runImplementation(run, spec, prior).pipe(
    Effect.tapError((failure) =>
      runs
        .stepFailed({
          ...ids,
          error: failure.message,
          final: !failure.retry,
          now: now(),
        })
        .pipe(Effect.ignore),
    ),
  );
  yield* recording(runs.stepCompleted({ ...ids, outputs, now: now() }));
  return outputs;
});

/**
 * A failed step's message. Cloudflare prefixes a rethrown non-retryable
 * error's message with its name; the diagnostic doesn't need it.
 */
const errorMessage = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).replace(
    /^NonRetryableError: /u,
    "",
  );

/**
 * A run's Workflow body: the one interpreter of a captured definition. It
 * loads the run (capturing its steps in the first checkpoint), executes the
 * steps in their saved order, each through the durable Steps adapter with its
 * registry-owned retry policy, and records the outcome. On replay, completed
 * steps return their checkpointed outputs without executing again. A
 * terminal failure, or a transient one that outlasts its retries, stops the
 * run with a diagnostic.
 */
export const executeWorkflowRun = async (
  params: WorkflowRunParams,
  steps: Steps,
  run: Runner,
): Promise<ExecutionResult> => {
  /** Run a step body; a failure becomes the error its retry needs. */
  const body = async <A>(
    program: Effect.Effect<A, StepFailure, ExecutorServices>,
  ): Promise<A> => {
    const result = await run(Effect.result(program));
    if (Result.isSuccess(result)) return result.success;
    throw result.failure.retry
      ? new Error(result.failure.message)
      : new NonRetryableStepError(result.failure.message);
  };

  const captured = await steps.do("start run", () =>
    body(
      recording(
        WorkflowRuns.use((runs) => runs.start(params.runId, now())),
      ) as Effect.Effect<Json, StepFailure, ExecutorServices>,
    ),
  );
  if (captured === null) return { status: "inactive" };
  const execution = captured as unknown as CapturedRun;

  // Code-owned, so reading it outside a step is deterministic.
  const policies = await run(
    StepRegistry.use((registry) =>
      Effect.succeed(
        execution.steps.map(
          (spec) => registry.get(spec.type)?.policy ?? DEFAULT_STEP_POLICY,
        ),
      ),
    ),
  );

  const outputs = new Map<string, StepOutputs>();
  let current: StepSpec | undefined;
  try {
    for (const [index, spec] of execution.steps.entries()) {
      current = spec;
      const produced = await steps.do(
        `step ${spec.id}`,
        () => body(attemptStep(execution, index, outputs)),
        policies[index],
      );
      outputs.set(spec.id, produced);
    }
    current = undefined;
    await steps.do("complete run", () =>
      body(
        recording(
          WorkflowRuns.use((runs) => runs.complete(params.runId, now())),
        ),
      ),
    );
    return { status: "completed" };
  } catch (cause) {
    const message = errorMessage(cause);
    const failed = current;
    await steps.do("record failure", () =>
      body(
        recording(
          WorkflowRuns.use((runs) =>
            runs.fail({
              runId: params.runId,
              error:
                failed === undefined
                  ? message
                  : `Step "${failed.id}" failed: ${message}`,
              ...(failed === undefined ? {} : { stepId: failed.id }),
              now: now(),
            }),
          ),
        ),
      ),
    );
    throw cause;
  }
};
