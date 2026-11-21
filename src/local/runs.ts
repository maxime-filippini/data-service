import { Effect, Layer } from "effect";

import { D1AssetsLive } from "$/assets/d1";
import { D1DatasetPublicationStoreLive } from "$/datasets/d1";
import type { DatasetObjectStore } from "$/datasets/store";
import type { Dependencies } from "$/dependencies";
import { MarketDataSourcesLayer, type SourceFor } from "$/market-data/sources";
import { OperationError, PythonOperations } from "$/operations/client";
import { D1PortfoliosLive } from "$/portfolios/d1";
import type { RunArtifacts } from "$/workflows/artifacts";
import { D1WorkflowsLive } from "$/workflows/d1";
import { executeWorkflowRun } from "$/workflows/executor";
import {
  builtInStepTypes,
  StepRegistryLayer,
  type StepType,
} from "$/workflows/registry";
import { D1WorkflowRunsLive } from "$/workflows/runs/d1";

import { type LocalPlatformOptions, localRunPlatform } from "./platform";
import { memoryDatasetObjectStore } from "./published";

/** What a local composition of the workflow service runs against. */
export interface LocalServiceOptions {
  readonly db: D1Database;
  /** Where run artifacts go: files or memory. */
  readonly artifacts: Layer.Layer<RunArtifacts>;
  /** Provider adapters, normally answering from fixtures. */
  readonly sourceFor: SourceFor;
  /**
   * The Python operations: the real service over HTTP (see
   * `startPythonService`). Without it, steps calling Python fail.
   */
  readonly python?: Layer.Layer<PythonOperations>;
  /** Where published datasets go: files or memory (default). */
  readonly published?: Layer.Layer<DatasetObjectStore>;
  /** Step types besides the built-in ones (test-only types). */
  readonly extraStepTypes?: readonly StepType[];
  readonly platform?: LocalPlatformOptions;
  /** Wall clock for tests that advance durable waits without real delays. */
  readonly now?: () => number;
}

/** No Python service: every call fails terminally, saying so. */
const noPython = Layer.succeed(
  PythonOperations,
  PythonOperations.of({
    invoke: (name) =>
      Effect.fail(
        new OperationError({
          kind: "terminal",
          message: `No Python service is configured locally to run ${name}`,
        }),
      ),
  }),
);

/**
 * The workflow service composed from local adapters: SQLite D1, local
 * artifacts, injected providers, and an in-process Workflow binding that
 * executes runs with the real executor and step implementations. Returns
 * dependencies for `createRoutes` and the platform's controls.
 */
export const localWorkflowService = (options: LocalServiceOptions) => {
  const registry = StepRegistryLayer([
    ...builtInStepTypes,
    ...(options.extraStepTypes ?? []),
  ]);
  const published = options.published ?? memoryDatasetObjectStore().layer;
  const datasets = Layer.merge(
    D1DatasetPublicationStoreLive(options.db),
    published,
  );
  const executorLayer = Layer.mergeAll(
    D1WorkflowRunsLive(options.db),
    registry,
    D1AssetsLive(options.db),
    D1PortfoliosLive(options.db),
    MarketDataSourcesLayer(options.sourceFor),
    options.artifacts,
    options.python ?? noPython,
    datasets,
  );
  const platform = localRunPlatform(
    (params, steps) =>
      executeWorkflowRun(
        params,
        steps,
        (program) =>
          program.pipe(Effect.provide(executorLayer), Effect.runPromise),
        options.now,
      ),
    options.platform,
  );
  const dependencies = {
    assetsFor: () => D1AssetsLive(options.db),
    portfoliosFor: () => D1PortfoliosLive(options.db),
    workflowsFor: () => Layer.merge(D1WorkflowsLive(options.db), registry),
    workflowRunsFor: () =>
      Layer.merge(D1WorkflowRunsLive(options.db), options.artifacts),
    runPlatformFor: () => platform,
    datasetsFor: () => datasets,
  } satisfies Dependencies;
  return { dependencies, platform };
};
