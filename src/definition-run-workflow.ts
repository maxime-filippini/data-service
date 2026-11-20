import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect, Layer } from "effect";

import { D1AssetsLive } from "$/assets/d1";
import { MarketDataSourcesLayer, liveSourceFor } from "$/market-data/sources";
import { R2RunArtifactsLive } from "$/workflows/artifacts";
import { executeWorkflowRun } from "$/workflows/executor";
import { StepRegistryLive } from "$/workflows/registry";
import type { WorkflowRunParams } from "$/workflows/runs/contracts";
import { D1WorkflowRunsLive } from "$/workflows/runs/d1";
import { workflowSteps } from "$/workflows/steps";

/**
 * One run of a workflow definition for one subject. The instance ID is the
 * run ID. The logic lives in `executeWorkflowRun`; this class only wires the
 * Worker's adapters: D1 records, the step registry, live provider
 * integrations and R2 run artifacts (in the raw bucket, under `runs/`).
 */
export class DefinitionRunWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  WorkflowRunParams
> {
  override async run(
    event: WorkflowEvent<WorkflowRunParams>,
    step: WorkflowStep,
  ) {
    const db = this.env.MARKET_DATA_DB;
    const layer = Layer.mergeAll(
      D1WorkflowRunsLive(db),
      StepRegistryLive,
      D1AssetsLive(db),
      MarketDataSourcesLayer(liveSourceFor(this.env)),
      R2RunArtifactsLive(this.env.MARKET_DATA_BUCKET),
    );
    return executeWorkflowRun(
      event.payload,
      workflowSteps(step, (error) => new NonRetryableError(error.message)),
      (program) => program.pipe(Effect.provide(layer), Effect.runPromise),
    );
  }
}
