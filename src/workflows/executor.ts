import { Clock, Effect, Result } from "effect";

import { nowIso } from "$/clock";
import { validateValueDescribed } from "$/schema";
import type { StepSpec } from "$/workflows/contracts";
import { outputReference, parseReference } from "$/workflows/references";
import {
  asTransient,
  defectsAsTransient,
  type RunContext,
  runContextFields,
  type StepFailure,
  StepRegistry,
  type StepServices,
  type StepType,
  terminal,
} from "$/workflows/registry";
import type { WorkflowRunParams } from "$/workflows/runs/contracts";
import { type CapturedRun, WorkflowRuns } from "$/workflows/runs/store";
import {
  DEFAULT_STEP_POLICY,
  NonRetryableStepError,
  type StepPolicy,
  type WorkflowSteps,
} from "$/workflows/steps";

/**
 * Largest serialized outputs one step may return. Outputs are checkpointed
 * by the platform and recorded for inspection, so large data belongs in an
 * artifact whose reference is the output.
 */
export const MAX_STEP_OUTPUT_BYTES = 32 * 1024;

const DEPENDENCY_CHECK_INTERVAL_MS = 60_000;

/** The services a run's execution needs. */
export type ExecutorServices = WorkflowRuns | StepRegistry | StepServices;

/** Runs an Effect program with the executor's services. */
export type Runner = <A, E>(
  program: Effect.Effect<A, E, ExecutorServices>,
) => Promise<A>;

type RunStepBody = <A>(
  program: Effect.Effect<A, StepFailure, ExecutorServices>,
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
    const decoded = validateValueDescribed(port.contract.schema, value.success);
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
      const decoded = validateValueDescribed(
        port.contract.schema,
        values[name],
      );
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

/** Resolve the parameters and input bindings for a registered step. */
const resolveRequest = Effect.fn("Workflows.resolveStepRequest")(function* (
  run: CapturedRun,
  spec: StepSpec,
  prior: ReadonlyMap<string, StepOutputs>,
  stepType: StepType,
) {
  const params = validateValueDescribed(stepType.params, spec.params);
  if (Result.isFailure(params))
    return yield* terminal(`Invalid params: ${params.failure}`);
  const inputs = yield* resolveInputs(spec, stepType, run.context, prior);
  return {
    params: params.success,
    inputs,
    context: run.context,
    execution: {
      workflowId: run.workflowId,
      runId: run.runId,
      stepId: spec.id,
    },
  };
});

/** Decode params, resolve inputs and run the step type's implementation. */
const runImplementation = Effect.fn("Workflows.runImplementation")(function* (
  run: CapturedRun,
  spec: StepSpec,
  prior: ReadonlyMap<string, StepOutputs>,
  stepType: StepType | undefined,
) {
  if (stepType === undefined)
    return yield* terminal(`Unknown step type "${spec.type}"`);
  if (stepType.implementation === undefined)
    return yield* terminal(`Step type "${spec.type}" cannot be executed yet`);
  const request = yield* resolveRequest(run, spec, prior, stepType);
  const produced = yield* defectsAsTransient(stepType.implementation(request));
  return yield* validateOutputs(stepType, produced);
});

/**
 * One attempt of one step: record its start, run it, and record its outputs
 * or failure. Repeating it is safe: outputs go to IDs fixed by the run and
 * step, and the records are upserts.
 */
const attemptStep = Effect.fn("Workflows.attemptStep")(function* (
  run: CapturedRun,
  index: number,
  prior: ReadonlyMap<string, StepOutputs>,
  stepType: StepType | undefined,
) {
  const spec = run.steps[index]!;
  const runs = yield* WorkflowRuns;
  const ids = { runId: run.runId, stepId: spec.id };
  yield* asTransient(
    runs.stepStarted({
      ...ids,
      position: index + 1,
      type: spec.type,
      now: yield* nowIso,
    }),
  );
  const outputs = yield* runImplementation(run, spec, prior, stepType).pipe(
    Effect.tapError((failure) =>
      Effect.flatMap(nowIso, (now) =>
        runs.stepFailed({
          ...ids,
          error: failure.message,
          final: !failure.retry,
          now,
        }),
      ).pipe(Effect.ignore),
    ),
  );
  yield* asTransient(
    runs.stepCompleted({ ...ids, outputs, now: yield* nowIso }),
  );
  return outputs;
});

/**
 * A wait step: resolve its deadline once, then check until it is ready or
 * the deadline passes, sleeping durably between checks. The checks and
 * absolute wake times are checkpointed so replay cannot reset the wait.
 */
const waitForStep = async (
  run: CapturedRun,
  index: number,
  prior: ReadonlyMap<string, StepOutputs>,
  stepType: StepType,
  wait: NonNullable<StepType["wait"]>,
  steps: WorkflowSteps,
  body: RunStepBody,
  policy: StepPolicy,
): Promise<StepOutputs> => {
  const spec = run.steps[index]!;
  const ids = { runId: run.runId, stepId: spec.id };

  const startWait = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    yield* asTransient(
      WorkflowRuns.use((runs) =>
        runs.stepStarted({
          ...ids,
          position: index + 1,
          type: spec.type,
          now: new Date(startedAt).toISOString(),
        }),
      ),
    );
    const request = yield* resolveRequest(run, spec, prior, stepType);
    return new Date(startedAt + wait.timeoutMs(request.params)).toISOString();
  });
  const deadline = await steps.do(
    `start wait ${spec.id}`,
    () => body(startWait),
    policy,
  );
  const deadlineMs = Date.parse(deadline);

  const checkOnce = Effect.gen(function* () {
    const request = yield* resolveRequest(run, spec, prior, stepType);
    const runs = yield* WorkflowRuns;
    const result = yield* defectsAsTransient(wait.check(request, deadline));
    if (result.ready) {
      const outputs = yield* validateOutputs(stepType, result.outputs);
      yield* asTransient(
        runs.stepCompleted({
          ...ids,
          outputs,
          now: yield* nowIso,
          resumesRun: true,
        }),
      );
      return { ready: true as const, outputs };
    }
    yield* asTransient(
      runs.stepWaiting({
        ...ids,
        waiting: { deadline, missing: result.missing },
      }),
    );
    const observedAt = yield* Clock.currentTimeMillis;
    if (observedAt >= deadlineMs) {
      const symbols = result.missing.map(({ symbol }) => symbol);
      return yield* terminal(
        `Timed out waiting for asset publications: ${symbols.join(", ")}`,
      );
    }
    return {
      ready: false as const,
      wakeAt: Math.min(deadlineMs, observedAt + DEPENDENCY_CHECK_INTERVAL_MS),
    };
  });
  for (let check = 1; ; check += 1) {
    const result = await steps.do(
      `check ${spec.id} ${check}`,
      () => body(checkOnce),
      policy,
    );
    if (result.ready) return result.outputs;
    await steps.sleepUntil(`wait ${spec.id} ${check}`, result.wakeAt);
  }
};

/**
 * A failed step's message. Cloudflare prefixes a rethrown non-retryable
 * error's message with its name; the diagnostic doesn't need it.
 */
const errorMessage = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).replace(
    /^NonRetryableError: /u,
    "",
  );

/** How an execution environment runs the executor. */
export interface ExecuteOptions {
  /**
   * Retries and timeout for each step's attempts; `DEFAULT_STEP_POLICY`
   * when omitted. The Steps adapter applies it as its runtime can.
   */
  readonly stepPolicy?: StepPolicy;
}

/**
 * A run's Workflow body: the one interpreter of a captured definition. It
 * loads the run (capturing its steps in the first checkpoint), executes the
 * steps in their saved order, each through the durable Steps adapter with
 * the environment's step policy, and records the outcome. On replay,
 * completed steps return their checkpointed outputs without executing again.
 * A terminal failure, or a transient one that outlasts its retries, stops
 * the run with a diagnostic.
 */
export const executeWorkflowRun = async (
  params: WorkflowRunParams,
  steps: WorkflowSteps,
  run: Runner,
  { stepPolicy = DEFAULT_STEP_POLICY }: ExecuteOptions = {},
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

  const startRun = asTransient(
    Effect.flatMap(nowIso, (now) =>
      WorkflowRuns.use((runs) => runs.start(params.runId, now)),
    ),
  ) as Effect.Effect<Json, StepFailure, ExecutorServices>;
  const captured = await steps.do("start run", () => body(startRun));
  if (captured === null) return { status: "inactive" };
  const execution = captured as unknown as CapturedRun;

  // Code-owned, so reading it outside a step is deterministic.
  const types = await run(
    StepRegistry.use((registry) =>
      Effect.succeed(execution.steps.map((spec) => registry.get(spec.type))),
    ),
  );

  const outputs = new Map<string, StepOutputs>();
  let current: StepSpec | undefined;
  try {
    for (const [index, spec] of execution.steps.entries()) {
      current = spec;
      const stepType = types[index];
      let produced: StepOutputs;
      if (stepType?.wait === undefined) {
        const attempt = attemptStep(execution, index, outputs, stepType);
        produced = await steps.do(
          `step ${spec.id}`,
          () => body(attempt),
          stepPolicy,
        );
      } else {
        produced = await waitForStep(
          execution,
          index,
          outputs,
          stepType,
          stepType.wait,
          steps,
          body,
          stepPolicy,
        );
      }
      outputs.set(spec.id, produced);
    }
    current = undefined;
    const completeRun = asTransient(
      Effect.flatMap(nowIso, (now) =>
        WorkflowRuns.use((runs) => runs.complete(params.runId, now)),
      ),
    );
    await steps.do("complete run", () => body(completeRun));
    return { status: "completed" };
  } catch (cause) {
    const message = errorMessage(cause);
    const failed = current;
    const recordFailure = asTransient(
      Effect.flatMap(nowIso, (now) =>
        WorkflowRuns.use((runs) =>
          runs.fail({
            runId: params.runId,
            error:
              failed === undefined
                ? message
                : `Step "${failed.id}" failed: ${message}`,
            ...(failed === undefined ? {} : { stepId: failed.id }),
            now,
          }),
        ),
      ),
    );
    await steps.do("record failure", () => body(recordFailure));
    throw cause;
  }
};
