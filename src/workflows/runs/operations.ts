import { Effect, Result, Schema } from "effect";

import { RunArtifacts } from "$/workflows/artifacts";
import { type Subject, WorkflowError } from "$/workflows/contracts";
import { ArtifactReferenceSchema } from "$/workflows/registry";

import type { RunPlatform, RunTrigger, WorkflowRunSummary } from "./contracts";
import { WorkflowRuns } from "./store";

/**
 * Application operations for runs, shared by the management API, the app's
 * API and the scheduled dispatcher (`dispatch.ts`): claim an assignment,
 * launch its Workflow instance under the run's ID, and reconcile launches
 * whose outcome is uncertain.
 */

/** Instance statuses after which a run can no longer record its outcome. */
const STOPPED: ReadonlySet<string> = new Set([
  "errored",
  "terminated",
  "complete",
]);

/**
 * The run's instance status, or undefined when it cannot be determined: the
 * lookup failed because the instance is absent or the platform unreachable.
 */
const instanceStatus = (platform: RunPlatform, runId: string) =>
  Effect.promise(() =>
    platform
      .get(runId)
      .then((instance) => instance.status())
      .then(
        (status): string | undefined => status.status,
        () => undefined,
      ),
  );

/**
 * Launch the run's Workflow instance, whose ID is the run ID. If creating it
 * fails but the instance exists (this or an earlier attempt went through),
 * it is launched. Otherwise the outcome is uncertain and the run stays
 * queued for reconciliation: creating the same ID again cannot duplicate it.
 */
export const launchRun = (platform: RunPlatform, runId: string) =>
  Effect.promise(async (): Promise<"launched" | "uncertain"> => {
    try {
      await platform.create({ id: runId, params: { runId } });
      return "launched";
    } catch {
      return platform.get(runId).then(
        () => "launched" as const,
        () => "uncertain" as const,
      );
    }
  });

/**
 * Bring an active run's record in line with its Workflow instance. A run
 * whose instance stopped without recording an outcome fails, releasing the
 * assignment. An instance whose status cannot be read is not evidence that
 * it is absent, so the claim is kept; a queued run is launched again under
 * the same ID in case it never launched.
 */
export const reconcileRun = Effect.fn("WorkflowRuns.reconcile")(function* (
  platform: RunPlatform,
  run: WorkflowRunSummary,
  now: Date,
) {
  const runs = yield* WorkflowRuns;
  const status = yield* instanceStatus(platform, run.id);
  if (status === undefined) {
    if (run.status === "queued") yield* launchRun(platform, run.id);
    return "kept" as const;
  }
  if (!STOPPED.has(status)) return "kept" as const;
  yield* runs.fail({
    runId: run.id,
    error: `The run's Workflow instance stopped (${status}) without recording an outcome`,
    now: now.toISOString(),
  });
  return "failed" as const;
});

/** What to run: an assignment, a processing date and why. */
export interface StartRun {
  readonly workflowId: string;
  readonly subject: Subject;
  readonly processingDate: string;
  readonly trigger: RunTrigger;
  readonly rerunOf?: string;
  /** The schedule occurrence a scheduled run claims (ISO whole UTC hour). */
  readonly scheduledFor?: string;
}

/**
 * Claim an assignment and launch the claimed run: the one path manual and
 * scheduled runs share. Reconciles the assignment's active run first, then
 * atomically claims the one active-run slot (and, for a scheduled run, its
 * occurrence), capturing the current definition. When another run still
 * holds the slot, the new run is recorded as `skipped` and nothing
 * launches. `claimed` is false when the assignment had already claimed the
 * occurrence; the earlier run is returned and nothing is launched again.
 * Requires an enabled definition, assignment and (for an asset) asset.
 */
export const claimAndLaunch = Effect.fn("WorkflowRuns.claimAndLaunch")(
  function* (input: StartRun, now: Date, platform: RunPlatform) {
    const runs = yield* WorkflowRuns;
    for (const active of yield* runs.active(input.workflowId, input.subject))
      yield* reconcileRun(platform, active, now);

    const outcome = yield* runs.claim({
      runId: crypto.randomUUID(),
      workflowId: input.workflowId,
      subject: input.subject,
      processingDate: input.processingDate,
      trigger: input.trigger,
      rerunOf: input.rerunOf ?? null,
      scheduledFor: input.scheduledFor ?? null,
      now: now.toISOString(),
    });
    if (outcome.claimed && outcome.run.status === "queued")
      yield* launchRun(platform, outcome.run.id);
    return outcome;
  },
);

/**
 * Start an assignment for a processing date and return its run straight
 * away (see `claimAndLaunch`).
 */
export const startRun = (input: StartRun, now: Date, platform: RunPlatform) =>
  Effect.map(claimAndLaunch(input, now, platform), (outcome) => outcome.run);

/**
 * Run a run's assignment and processing date again as a new run from the
 * beginning, with the definition as it is now.
 */
export const rerun = Effect.fn("WorkflowRuns.rerun")(function* (
  runId: string,
  now: Date,
  platform: RunPlatform,
) {
  const runs = yield* WorkflowRuns;
  const previous = yield* runs.get(runId);
  return yield* startRun(
    {
      workflowId: previous.workflowId,
      subject: previous.subject,
      processingDate: previous.processingDate,
      trigger: "manual",
      rerunOf: previous.id,
    },
    now,
    platform,
  );
});

const notFound = (message: string) =>
  new WorkflowError({ kind: "not_found", message });

/**
 * Read the artifact a run's step output references, with its contents. Only
 * reads: nothing executes. Only references recorded as a run's outputs are
 * read, so callers never name storage paths.
 */
export const getRunArtifact = Effect.fn("WorkflowRuns.getArtifact")(function* (
  runId: string,
  stepId: string,
  output: string,
) {
  const run = yield* WorkflowRuns.use((runs) => runs.get(runId));
  const step = run.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined)
    return yield* notFound(`The run has no step "${stepId}"`);
  const value =
    step.outputs !== null && Object.hasOwn(step.outputs, output)
      ? step.outputs[output]
      : undefined;
  if (value === undefined)
    return yield* notFound(`Step "${stepId}" has no output "${output}"`);
  const reference = Schema.decodeUnknownResult(ArtifactReferenceSchema)(value);
  if (Result.isFailure(reference))
    return yield* notFound(
      `Output "${output}" of step "${stepId}" is not an artifact reference`,
    );
  const content = yield* RunArtifacts.use((artifacts) =>
    artifacts.get(reference.success.id),
  ).pipe(
    Effect.mapError(
      (error) =>
        new WorkflowError({ kind: "database", message: error.message }),
    ),
  );
  if (content === null)
    return yield* notFound(
      "The artifact no longer exists; temporary run artifacts expire",
    );
  return { reference: reference.success, content };
});
