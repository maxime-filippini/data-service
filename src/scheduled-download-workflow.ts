import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Effect, Layer } from "effect";

import { D1ScheduleStoreLive } from "$/market-data/schedule/d1";
import { type ScheduledDownloadParams } from "$/market-data/schedule/operations";
import { runScheduledDownload } from "$/market-data/schedule/workflow";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { workflowSteps } from "$/workflows/steps";

/** One run of the daily schedule. The logic lives in `runScheduledDownload`. */
export class ScheduledDownloadWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  ScheduledDownloadParams
> {
  override async run(
    event: WorkflowEvent<ScheduledDownloadParams>,
    step: WorkflowStep,
  ) {
    const layer = Layer.mergeAll(
      D1SymbolRegistryLive(this.env.MARKET_DATA_DB),
      D1ScheduleStoreLive(this.env.MARKET_DATA_DB),
    );
    return runScheduledDownload(event.payload, workflowSteps(step), {
      run: (program) => program.pipe(Effect.provide(layer), Effect.runPromise),
      queue: this.env.INGESTION_QUEUE,
    });
  }
}
