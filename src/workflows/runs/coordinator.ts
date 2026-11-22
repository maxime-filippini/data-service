import { Clock, Context, Effect, Layer } from "effect";

import { Checkpointer } from "$/workflows/checkpointer";
import type { WorkflowError } from "$/workflows/contracts";
import type { StepFailure } from "$/workflows/registry";

import type { WorkflowRunSummary } from "./contracts";
import {
  type DispatchOptions,
  dispatchScheduledRuns,
  type TickReport,
  workflowDispatchEnabled,
} from "./dispatch";
import { RunLauncher } from "./launcher";
import { rerun, type StartRun, startRun } from "./operations";
import { WorkflowRuns } from "./store";

/**
 * Starts runs: the one entry for manual starts, reruns and scheduled
 * dispatch, so callers depend on it instead of on the run store, the
 * launcher and the clock. Each start reconciles the assignment's active run,
 * claims the assignment and launches the claimed run.
 */
export class RunCoordinator extends Context.Service<
  RunCoordinator,
  {
    /** Claim and launch a run; `skipped` when another run is still active. */
    readonly start: (
      input: StartRun,
    ) => Effect.Effect<WorkflowRunSummary, WorkflowError>;
    /** Run an earlier run's assignment and date again, from the beginning. */
    readonly rerun: (
      runId: string,
    ) => Effect.Effect<WorkflowRunSummary, WorkflowError>;
    /**
     * Reconcile active runs, then claim and launch every assignment due at
     * `scheduledAt`, a batch per checkpoint of the dispatch instance.
     */
    readonly dispatchDue: (
      scheduledAt: Date,
      options?: DispatchOptions,
    ) => Effect.Effect<
      Extract<TickReport, { status: "dispatched" }>,
      StepFailure,
      Checkpointer
    >;
  }
>()("data-service/RunCoordinator") {}

const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms));

/** The RunCoordinator over the run store and the launcher. */
export const RunCoordinatorLive: Layer.Layer<
  RunCoordinator,
  never,
  WorkflowRuns | RunLauncher
> = Layer.effect(
  RunCoordinator,
  Effect.gen(function* () {
    const services = yield* Effect.context<WorkflowRuns | RunLauncher>();
    return RunCoordinator.of({
      start: (input) =>
        Effect.flatMap(now, (at) => startRun(input, at)).pipe(
          Effect.provide(services),
        ),
      rerun: (runId) =>
        Effect.flatMap(now, (at) => rerun(runId, at)).pipe(
          Effect.provide(services),
        ),
      dispatchDue: (scheduledAt, options) =>
        dispatchScheduledRuns(scheduledAt, options).pipe(
          Effect.provide(services),
        ),
    });
  }),
);

/**
 * The dispatch Workflow's body, gated by `WORKFLOW_DISPATCH`: the
 * coordinator's `dispatchDue` at the trigger's scheduled time, with the
 * host's services and the instance's Checkpointer. Tests and the fixture command call the same body
 * with a controlled time and a local Checkpointer.
 */
export const scheduledWorkflowTick = (
  services: Layer.Layer<RunCoordinator>,
  env: CloudflareBindings,
  scheduledAt: Date,
  checkpointer: typeof Checkpointer.Service,
  options: DispatchOptions = {},
): Promise<TickReport> =>
  workflowDispatchEnabled(env)
    ? RunCoordinator.use((runs) => runs.dispatchDue(scheduledAt, options)).pipe(
        Effect.provide(services),
        Effect.provideService(Checkpointer, checkpointer),
        Effect.runPromise,
      )
    : Promise.resolve({ status: "disabled" });
