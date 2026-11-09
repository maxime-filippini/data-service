import { Context, type Effect } from "effect";

import type {
  Calculation,
  CalculationError,
  CalculationPatch,
  CalculationRun,
  FinishedRun,
  NewCalculation,
  NewRun,
} from "./contracts";

/**
 * Injectable persistence interface for calculation configuration and execution
 * history. Obtain with `yield* Calculations`; supply `D1CalculationsLive` in the
 * Worker or a test implementation. Configuration operations validate type/params
 * before writes; the adapter owns atomic storage and the one-running-run rule.
 * This interface records runs but does not itself launch or call the engine.
 */
export class Calculations extends Context.Service<
  Calculations,
  {
    /** Every calculation, by name, with its latest run. */
    readonly list: () => Effect.Effect<
      readonly Calculation[],
      CalculationError
    >;
    readonly get: (id: string) => Effect.Effect<Calculation, CalculationError>;
    /** Fails with `invalid` if a portfolio doesn't exist. */
    readonly create: (
      calculation: NewCalculation,
      now: string,
    ) => Effect.Effect<Calculation, CalculationError>;
    readonly update: (
      id: string,
      patch: CalculationPatch,
      now: string,
    ) => Effect.Effect<Calculation, CalculationError>;
    /** Delete a calculation and its runs. Its results stay in R2. */
    readonly remove: (id: string) => Effect.Effect<void, CalculationError>;
    /**
     * Record that the schedule is starting a run for a cron slot. False if
     * that slot or a later one was already recorded, so a slot runs once.
     */
    readonly claimSlot: (
      id: string,
      slot: string,
    ) => Effect.Effect<boolean, CalculationError>;

    /**
     * Record a new run as `running`, or as `skipped` if the calculation already
     * has one running. Returns the status it got.
     */
    readonly startRun: (
      run: NewRun,
    ) => Effect.Effect<"running" | "skipped", CalculationError>;
    /** Save a finished run's result. */
    readonly finishRun: (
      runId: string,
      result: FinishedRun,
      at: string,
    ) => Effect.Effect<void, CalculationError>;
    /** Fail a run if it's still running. */
    readonly failRun: (
      runId: string,
      error: string,
      at: string,
    ) => Effect.Effect<void, CalculationError>;
    /** Runs still `running`, of one calculation or of all. */
    readonly runningRuns: (
      calculationId?: string,
    ) => Effect.Effect<readonly CalculationRun[], CalculationError>;
    /** A calculation's runs, newest first. */
    readonly listRuns: (
      calculationId: string,
      limit: number,
    ) => Effect.Effect<readonly CalculationRun[], CalculationError>;
    readonly getRun: (
      runId: string,
    ) => Effect.Effect<CalculationRun, CalculationError>;
  }
>()("data-service/Calculations") {}
