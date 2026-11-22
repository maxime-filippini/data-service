import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect, Layer } from "effect";

import { D1AssetStoreLive } from "$/assets/d1";
import { D1DatasetPublicationStoreLive } from "$/datasets/d1";
import { R2DatasetObjectStoreLive } from "$/datasets/r2";
import { MarketDataSourcesLayer, liveSourceFor } from "$/market-data/sources";
import { HttpPythonOperationsLive } from "$/operations/client";
import { D1PortfoliosLive } from "$/portfolios/d1";
import { R2RunArtifactsLive } from "$/workflows/artifacts";
import {
  CloudflareCheckpointerLive,
  runInstanceBody,
} from "$/workflows/cloudflare";
import { executeWorkflowRun } from "$/workflows/executor";
import { StepRegistryLive } from "$/workflows/registry";
import type { WorkflowRunParams } from "$/workflows/runs/contracts";
import { D1WorkflowRunsLive } from "$/workflows/runs/d1";

/**
 * One run of a workflow definition for one subject. The instance ID is the
 * run ID. The logic lives in `executeWorkflowRun`; this class only wires the
 * Worker's adapters: the instance's `step` as the Checkpointer, D1 records, the step registry, live provider
 * integrations, R2 run artifacts (in the raw bucket, under `runs/`), the
 * Python operations in the engine container, and published datasets (in the
 * processed bucket, with their metadata in D1).
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
      CloudflareCheckpointerLive(
        step,
        (message) => new NonRetryableError(message),
      ),
      D1WorkflowRunsLive(db),
      StepRegistryLive,
      D1AssetStoreLive(db),
      D1PortfoliosLive(db),
      MarketDataSourcesLayer(liveSourceFor(this.env)),
      R2RunArtifactsLive(this.env.MARKET_DATA_BUCKET),
      // Single named container instance for Python workflow operations.
      HttpPythonOperationsLive(
        this.env.CALCULATION_ENGINE.getByName("engine"),
        "http://engine",
      ),
      D1DatasetPublicationStoreLive(db),
      R2DatasetObjectStoreLive(this.env.PROCESSED_MARKET_DATA_BUCKET),
    );
    return runInstanceBody(
      executeWorkflowRun(event.payload).pipe(Effect.provide(layer)),
    );
  }
}
