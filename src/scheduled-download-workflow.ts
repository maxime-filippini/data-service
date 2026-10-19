import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Layer } from "effect";

import { runScheduledDownload, type ScheduledDownloadParams, type Steps } from "$/market-data/schedule";
import { D1ScheduleStoreLive } from "$/market-data/schedule/d1";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";

/** One run of the daily schedule. The logic lives in `runScheduledDownload`. */
export class ScheduledDownloadWorkflow extends WorkflowEntrypoint<CloudflareBindings, ScheduledDownloadParams> {
  override async run(event: WorkflowEvent<ScheduledDownloadParams>, step: WorkflowStep) {
    const layer = Layer.mergeAll(
      D1SymbolRegistryLive(this.env.MARKET_DATA_DB),
      D1ScheduleStoreLive(this.env.MARKET_DATA_DB),
    );
    const steps: Steps = { do: (name, run) => step.do(name, run as never) as never };
    return runScheduledDownload(event.payload, steps, {
      run: (program) => program.pipe(Effect.provide(layer), Effect.runPromise),
      queue: this.env.INGESTION_QUEUE,
    });
  }
}
