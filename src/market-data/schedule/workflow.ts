import type { Effect } from "effect";

import type { IngestionMessage } from "$/market-data/ingestion-queue";
import type { Dataset } from "$/market-data/schemas";
import { SymbolRegistry, type TrackedSymbol } from "$/market-data/symbol-registry";
import type { Steps } from "$/workflows/steps";

import type { ScheduledDownloadParams } from "./operations";
import { ScheduleStore } from "./store";

const QUEUE_BATCH_SIZE = 100;

/** Enabled symbols whose history has started by `snapshotTo`, in queue-sized batches. */
export const scheduledBatches = (symbols: readonly TrackedSymbol[], snapshotTo: string) => {
  const due = symbols.filter((symbol) => symbol.enabled && symbol.backfillStartDate <= snapshotTo);
  const batches: { dataset: Dataset; symbol: string }[][] = [];
  for (let index = 0; index < due.length; index += QUEUE_BATCH_SIZE) {
    batches.push(due.slice(index, index + QUEUE_BATCH_SIZE).map(({ dataset, symbol }) => ({ dataset, symbol })));
  }
  return { batches, skipped: symbols.filter((symbol) => symbol.enabled).length - due.length };
};

/**
 * The Workflow's body: list the enabled symbols, queue them in batches, then
 * record the outcome. A failure is recorded before the Workflow gives up.
 */
export const runScheduledDownload = async (
  params: ScheduledDownloadParams,
  steps: Steps,
  dependencies: {
    readonly run: <A, E>(program: Effect.Effect<A, E, SymbolRegistry | ScheduleStore>) => Promise<A>;
    readonly queue: Pick<Queue<IngestionMessage>, "sendBatch">;
  },
) => {
  const { run, queue } = dependencies;
  try {
    const { batches, skipped } = await steps.do("list enabled symbols", () =>
      run(SymbolRegistry.use((registry) => registry.list({ enabled: true }))).then((symbols) =>
        scheduledBatches(symbols, params.snapshotTo),
      ),
    );
    for (const [index, batch] of batches.entries()) {
      await steps.do(`queue batch ${index + 1} of ${batches.length}`, () =>
        queue.sendBatch(batch.map((entry) => ({ body: { ...entry, to: params.snapshotTo } }))).then(() => batch.length),
      );
    }
    const queued = batches.reduce((total, batch) => total + batch.length, 0);
    await steps.do("record completion", () =>
      run(
        ScheduleStore.use((store) =>
          store.completeRun(params.runId, { queued, skipped }, new Date().toISOString()),
        ),
      ),
    );
    return { queued, skipped };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await steps.do("record failure", () =>
      run(ScheduleStore.use((store) => store.failRun(params.runId, message, new Date().toISOString()))),
    );
    throw cause;
  }
};
