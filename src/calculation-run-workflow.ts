import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Layer } from "effect";

import { D1CalculationsLive } from "$/calculations/d1";
import { EngineLive } from "$/calculations/engine";
import { executeRun, type RunWorkflowParams, type Steps } from "$/calculations/runs";
import { D1PortfoliosLive } from "$/portfolios/d1";

/**
 * One run of a saved calculation. Runs can outlast a request, so they run
 * here, off the request path. The logic lives in `executeRun`.
 */
export class CalculationRunWorkflow extends WorkflowEntrypoint<CloudflareBindings, RunWorkflowParams> {
  override async run(event: WorkflowEvent<RunWorkflowParams>, step: WorkflowStep) {
    const layer = Layer.mergeAll(
      D1CalculationsLive(this.env.MARKET_DATA_DB),
      D1PortfoliosLive(this.env.MARKET_DATA_DB),
      EngineLive(this.env.CALCULATION_ENGINE.getByName("engine")),
    );
    const steps: Steps = {
      do: (name, run, config) =>
        (config === undefined ? step.do(name, run as never) : step.do(name, config, run as never)) as never,
    };
    return executeRun(event.payload, steps, (program) => program.pipe(Effect.provide(layer), Effect.runPromise));
  }
}
