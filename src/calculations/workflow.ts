import type { WorkflowStepConfig } from "cloudflare:workers";
import type { Effect } from "effect";

import type { Portfolios } from "$/portfolios/store";
import type { Steps } from "$/workflows/steps";

import type { Engine } from "./engine";
import { calculateRun, type RunWorkflowParams } from "./runs";
import { Calculations } from "./store";

/**
 * The engine step: a few retries for a cold or crashed container, and a
 * timeout so a hung request doesn't hold the calculation's run slot forever.
 */
export const ENGINE_STEP = {
  retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
  timeout: "30 minutes",
} satisfies WorkflowStepConfig;

/**
 * The Workflow's body: run the calculation, then record the result. A
 * failure is recorded before the Workflow gives up.
 */
export const executeRun = async (
  params: RunWorkflowParams,
  steps: Steps,
  run: <A, E>(program: Effect.Effect<A, E, Calculations | Portfolios | Engine>) => Promise<A>,
) => {
  try {
    const result = await steps.do("run calculation", () => run(calculateRun(params.runId)), ENGINE_STEP);
    if (result === null) return null;
    await steps.do("record result", () =>
      run(Calculations.use((store) => store.finishRun(params.runId, result, new Date().toISOString()))),
    );
    return result.status;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await steps.do("record failure", () =>
      run(Calculations.use((store) => store.failRun(params.runId, message, new Date().toISOString()))),
    );
    throw cause;
  }
};
