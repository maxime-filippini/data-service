import { Effect } from "effect";

import { WorkerLoggerLive } from "$/logging";
import { startScheduledWorkflowTick } from "$/workflows/runs/dispatch";

/** Whether this tick started the durable dispatch Workflow, which dispatches the due assignments. */
export type ScheduledHandlerOutcome =
  | Awaited<ReturnType<typeof startScheduledWorkflowTick>>
  | { readonly status: "failed"; readonly message: string };

/**
 * Execute the Worker's hourly scheduled tick: start the durable dispatch
 * Workflow, which reconciles active workflow runs and dispatches enabled
 * workflow assignments whose daily UTC hour is due. The instance starts on
 * `env.WORKFLOW_DISPATCHES`.
 */
export const runScheduledHandlers = (
  now: Date,
  env: CloudflareBindings,
): Promise<ScheduledHandlerOutcome> =>
  Effect.gen(function* () {
    const dispatch = yield* Effect.tryPromise(() =>
      startScheduledWorkflowTick(env, now, env.WORKFLOW_DISPATCHES),
    ).pipe(Effect.result);
    if (dispatch._tag === "Success") {
      if (dispatch.success.status === "started")
        yield* Effect.logInfo("workflow_dispatch_started").pipe(
          Effect.annotateLogs({ id: dispatch.success.id }),
        );
      return dispatch.success;
    }
    const error = dispatch.failure.cause;
    const message = error instanceof Error ? error.message : String(error);
    // Nothing claimed is lost: the next tick dispatches what is still due.
    yield* Effect.logError("workflow_dispatch_failed").pipe(
      Effect.annotateLogs({ message }),
    );
    return { status: "failed", message } as const;
  }).pipe(Effect.provide(WorkerLoggerLive), Effect.runPromise);
