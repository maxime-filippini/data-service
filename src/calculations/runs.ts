import { Effect } from "effect";

import {
  CalculationError,
  calculationOutputKey,
  type FinishedRun,
  type RunTrigger,
} from "$/calculations/contracts";
import { Engine, type PortfolioOutcome } from "$/calculations/engine";
import { Calculations } from "$/calculations/store";
import { Portfolios } from "$/portfolios/store";

/** What a run sends to its Workflow. The Workflow instance ID is the run ID. */
export interface RunWorkflowParams {
  readonly runId: string;
}

export type RunWorkflow = Pick<Workflow<RunWorkflowParams>, "create" | "get">;

/**
 * How long a run may be `running` before its Workflow is checked. Covers the
 * moment between recording a run and creating its Workflow.
 */
export const RUN_CHECK_GRACE_MS = 5 * 60 * 1000;

/** Workflow statuses after which a run can't report back any more. */
const STOPPED: ReadonlySet<string> = new Set(["errored", "terminated", "complete"]);

/** The Workflow's status, or null when it doesn't exist. */
const workflowStatus = (workflow: RunWorkflow, runId: string) =>
  Effect.promise(() =>
    workflow
      .get(runId)
      .then((instance) => instance.status())
      .then(
        (status) => status.status as string,
        () => null,
      ),
  );

/**
 * Fail runs left `running` whose Workflow has stopped or never started, for
 * example after a crash, so they don't block later runs. Only checks runs
 * older than `RUN_CHECK_GRACE_MS`. Returns how many it failed.
 */
export const failStoppedRuns = Effect.fn("Calculations.failStoppedRuns")(function* (
  workflow: RunWorkflow,
  now: Date,
  calculationId?: string,
) {
  const store = yield* Calculations;
  let failed = 0;
  for (const run of yield* store.runningRuns(calculationId)) {
    if (now.getTime() - Date.parse(run.createdAt) < RUN_CHECK_GRACE_MS) continue;
    const status = yield* workflowStatus(workflow, run.runId);
    if (status !== null && !STOPPED.has(status)) continue;
    const error =
      status === null ? "The run's workflow never started" : `The run stopped without reporting back (workflow ${status})`;
    yield* store.failRun(run.runId, error, now.toISOString());
    failed += 1;
  }
  return failed;
});

/**
 * Start a run of a calculation for one as-of date with its current params,
 * and return its ID straight away. If the calculation already has a run
 * going, the new one is recorded as `skipped` and nothing runs.
 */
export const startRun = Effect.fn("Calculations.startRun")(function* (
  calculationId: string,
  options: { readonly trigger: RunTrigger; readonly asOf: string },
  now: Date,
  workflow: RunWorkflow,
) {
  const store = yield* Calculations;
  const calculation = yield* store.get(calculationId);
  yield* failStoppedRuns(workflow, now, calculationId);

  const runId = crypto.randomUUID();
  const status = yield* store.startRun({
    runId,
    calculationId,
    trigger: options.trigger,
    asOf: options.asOf,
    params: calculation.params,
    createdAt: now.toISOString(),
  });
  if (status === "running") {
    yield* Effect.tryPromise({
      try: () => workflow.create({ id: runId, params: { runId } }),
      catch: (cause) =>
        new CalculationError({
          kind: "workflow",
          message: `Could not start the run: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }).pipe(Effect.tapError((error) => store.failRun(runId, error.message, new Date().toISOString())));
  }
  return { runId, status };
});

const noHoldings = (portfolioId: string, asOf: string): PortfolioOutcome => ({
  portfolioId,
  status: "failed",
  rowCount: 0,
  error: `No holdings on or before ${asOf}`,
});

/**
 * Run a calculation through the engine. Portfolios with no snapshot on or
 * before the as-of date fail here, without reaching the engine (which would
 * reject the whole request). Returns null if the run is gone or no longer
 * running. Fails when the engine can't be reached or crashes, so the caller
 * can retry: the engine replaces the as-of date's rows, so that's safe.
 */
export const calculateRun = Effect.fn("Calculations.calculateRun")(function* (runId: string) {
  const store = yield* Calculations;
  const missing = () => Effect.succeed(null);
  const run = yield* store.getRun(runId).pipe(Effect.catchIf((error) => error.kind === "not_found", missing));
  if (run === null || run.status !== "running") return null;
  const calculation = yield* store
    .get(run.calculationId)
    .pipe(Effect.catchIf((error) => error.kind === "not_found", missing));
  if (calculation === null) return null;

  const portfolios = yield* Portfolios;
  const loaded = yield* Effect.forEach(calculation.portfolioIds, (id) => portfolios.forEngine(id, run.asOf));
  const held = loaded.filter((portfolio) => portfolio.snapshots.length > 0);
  const empty = loaded.filter((portfolio) => portfolio.snapshots.length === 0).map((p) => noHoldings(p.id, run.asOf));

  if (loaded.length > 0 && held.length === 0) {
    const failed: FinishedRun = {
      status: "failed",
      error: empty.length === 1 ? empty[0]!.error : `All ${empty.length} portfolios failed`,
      portfolios: empty,
      rowCount: 0,
      outputEtag: null,
    };
    return failed;
  }

  const engine = yield* Engine;
  const result: FinishedRun = yield* engine
    .run({
      runId,
      type: calculation.type,
      params: run.params,
      asOf: run.asOf,
      portfolios: held,
      outputKey: calculationOutputKey(calculation.id),
    })
    .pipe(
      // A request the engine rejects won't work on a retry either.
      Effect.catchIf(
        (error) => error.kind === "invalid" || error.kind === "not_found",
        (error) =>
          Effect.succeed({
            status: "failed",
            error: `The engine rejected the run: ${error.message}`,
            portfolios: [],
            rowCount: 0,
            outputEtag: null,
          } satisfies FinishedRun),
      ),
    );
  if (empty.length === 0) return result;

  // Merge in the portfolios that had no holdings, in the calculation's order.
  const outcomes = new Map([...result.portfolios, ...empty].map((outcome) => [outcome.portfolioId, outcome]));
  const merged = calculation.portfolioIds.flatMap((id) => outcomes.get(id) ?? []);
  if (result.status !== "failed") return { ...result, status: "partial", portfolios: merged } satisfies FinishedRun;
  // The run failed as a whole: keep the engine's reason.
  if (result.portfolios.length === 0) return { ...result, portfolios: empty } satisfies FinishedRun;
  return { ...result, error: `All ${merged.length} portfolios failed`, portfolios: merged } satisfies FinishedRun;
});
