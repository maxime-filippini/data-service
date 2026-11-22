import { Clock, Effect, Layer } from "effect";

import { clockAt } from "$/clock";
import { D1AssetStoreLive } from "$/assets/d1";
import { D1DatasetPublicationStoreLive } from "$/datasets/d1";
import type { DatasetObjectStore } from "$/datasets/store";
import type { ServicesFor } from "$/dependencies";
import { MarketDataSourcesLayer, type SourceFor } from "$/market-data/sources";
import { OperationError, PythonOperations } from "$/operations/client";
import { D1PortfoliosLive } from "$/portfolios/d1";
import type { RunArtifacts } from "$/workflows/artifacts";
import { Checkpointer, type StepPolicy } from "$/workflows/checkpointer";
import { D1WorkflowStoreLive } from "$/workflows/d1";
import { executeWorkflowRun } from "$/workflows/executor";
import {
  builtInStepTypes,
  StepRegistryLayer,
  type StepType,
} from "$/workflows/registry";
import { D1WorkflowRunsLive } from "$/workflows/runs/d1";
import type { RunPlatform } from "$/workflows/runs/contracts";
import { RunCoordinatorLive } from "$/workflows/runs/coordinator";
import { BindingRunLauncherLive } from "$/workflows/runs/launcher";

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
  /** The step policy this environment runs steps with; the executor's default otherwise. */
  readonly stepPolicy?: StepPolicy;
  /**
   * Wraps the in-process Workflow binding the RunLauncher uses, so tests can
   * lose or fail creates and lookups the way the platform can.
   */
  readonly wrapBinding?: (binding: RunPlatform) => RunPlatform;
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
 * The local host: the same services as on Cloudflare, from local adapters.
 * SQLite D1, file or memory stores, injected providers, an optional Python
 * service, and an in-process Workflow binding that executes runs with the
 * real executor, step implementations and a local Checkpointer. Returns
 * `servicesFor` (the host's layer, for `createRoutes`, `pageData` and the
 * dispatch tick) and the platform's controls.
 */
export const localWorkflowService = (options: LocalServiceOptions) => {
  const db = options.db;
  const clock: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R> =
    options.now === undefined
      ? (effect) => effect
      : (effect) =>
          Effect.provideService(effect, Clock.Clock, clockAt(options.now!));
  const platform = localRunPlatform(
    (params, checkpointer) =>
      executeWorkflowRun(
        params,
        options.stepPolicy === undefined
          ? {}
          : { stepPolicy: options.stepPolicy },
      ).pipe(
        Effect.provide(services),
        Effect.provideService(Checkpointer, checkpointer),
        clock,
      ),
    options.platform,
  );
  const adapters = Layer.mergeAll(
    D1AssetStoreLive(db),
    D1PortfoliosLive(db),
    D1WorkflowStoreLive(db),
    StepRegistryLayer([...builtInStepTypes, ...(options.extraStepTypes ?? [])]),
    D1WorkflowRunsLive(db),
    options.artifacts,
    BindingRunLauncherLive(options.wrapBinding?.(platform) ?? platform),
    MarketDataSourcesLayer(options.sourceFor),
    options.python ?? noPython,
    D1DatasetPublicationStoreLive(db),
    options.published ?? memoryDatasetObjectStore().layer,
  );
  const services = Layer.provideMerge(RunCoordinatorLive, adapters);
  const servicesFor: ServicesFor = () => services;
  return { servicesFor, platform };
};
