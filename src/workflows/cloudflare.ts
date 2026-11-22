import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { Cause, Effect, Exit, Layer } from "effect";

import { Checkpointer, type Json } from "$/workflows/checkpointer";
import { type StepFailure, terminal } from "$/workflows/registry";

/**
 * A failure's message without Cloudflare's prefix: the platform rethrows a
 * non-retryable error with its name in front, which a diagnostic doesn't
 * need.
 */
const platformMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^NonRetryableError: /u,
    "",
  );

/**
 * The Checkpointer on Cloudflare Workflows: each checkpoint is a `step.do`
 * and each sleep a `step.sleepUntil` of the instance's `step`.
 *
 * Inside `step.do`, the body runs with the services it was given. A
 * transient failure is thrown as a plain error, which the platform retries
 * within the policy; a terminal failure is thrown as `nonRetryable(message)`
 * (Cloudflare's `NonRetryableError`, passed in because `cloudflare:workflows`
 * only loads in the Workers runtime). When the platform gives up, the
 * checkpoint fails with a terminal failure carrying the last message.
 */
export const cloudflareCheckpointer = (
  step: WorkflowStep,
  nonRetryable: (message: string) => Error,
): typeof Checkpointer.Service =>
  Checkpointer.of({
    checkpoint: <A extends Json, R>(
      name: string,
      body: Effect.Effect<A, StepFailure, R>,
      policy?: WorkflowStepConfig,
    ) =>
      Effect.flatMap(Effect.context<R>(), (context) =>
        Effect.tryPromise({
          try: () => {
            const attempt = async () => {
              const exit = await Effect.runPromiseExitWith(context)(body);
              if (Exit.isSuccess(exit)) return exit.value;
              const failure = Cause.findErrorOption(exit.cause);
              if (failure._tag === "Some")
                throw failure.value.retry
                  ? new Error(failure.value.message)
                  : nonRetryable(failure.value.message);
              throw Cause.squash(exit.cause);
            };
            // The platform requires serializable results; Json is.
            const run = attempt as () => Promise<never>;
            return (
              policy === undefined
                ? step.do(name, run)
                : step.do(name, policy, run)
            ) as Promise<A>;
          },
          catch: (error) => terminal(platformMessage(error)),
        }),
      ),
    sleepUntil: (name, at) => Effect.promise(() => step.sleepUntil(name, at)),
  });

/** `cloudflareCheckpointer` as a Layer. */
export const CloudflareCheckpointerLive = (
  step: WorkflowStep,
  nonRetryable: (message: string) => Error,
): Layer.Layer<Checkpointer> =>
  Layer.succeed(Checkpointer, cloudflareCheckpointer(step, nonRetryable));

/**
 * Run a Workflow instance's body to its end. A failure is rethrown as a
 * plain error with the failure's message, so the platform marks the
 * instance errored with a readable diagnostic.
 */
export const runInstanceBody = async <A>(
  program: Effect.Effect<A, StepFailure>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  throw failure._tag === "Some"
    ? new Error(failure.value.message)
    : Cause.squash(exit.cause);
};
