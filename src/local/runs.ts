import { Effect, Layer } from "effect";

import { D1AssetsLive } from "$/assets/d1";
import type { Dependencies } from "$/dependencies";
import { MarketDataSourcesLayer, type SourceFor } from "$/market-data/sources";
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

/** What a local composition of the workflow service runs against. */
export interface LocalServiceOptions {
  readonly db: D1Database;
  /** Where run artifacts go: files or memory. */
  readonly artifacts: Layer.Layer<RunArtifacts>;
  /** Provider adapters, normally answering from fixtures. */
  readonly sourceFor: SourceFor;
  /** Step types besides the built-in ones (test-only types). */
  readonly extraStepTypes?: readonly StepType[];
  readonly platform?: LocalPlatformOptions;
}

const missing = (name: string) =>
  new Error(`${name} is not available in the local workflow service`);

/**
 * A legacy service's layer. Building it fails, so pages that construct every
 * layer still work and only using the service fails.
 */
const unavailable =
  (name: string) =>
  <A>(): Layer.Layer<A> =>
    Layer.effectDiscard(
      Effect.die(missing(name)),
    ) as Layer.Layer<never> as Layer.Layer<A>;

/** A legacy Workflow binding: selecting it fails. */
const unavailableBinding = (name: string) => (): never => {
  throw missing(name);
};

/**
 * The workflow service composed from local adapters: SQLite D1, local
 * artifacts, injected providers, and an in-process Workflow binding that
 * executes runs with the real executor and step implementations. Returns
 * dependencies for `createRoutes` (only asset, portfolio, workflow and run
 * routes work; legacy routes fail) and the platform's controls.
 */
export const localWorkflowService = (options: LocalServiceOptions) => {
  const registry = StepRegistryLayer([
    ...builtInStepTypes,
    ...(options.extraStepTypes ?? []),
  ]);
  const executorLayer = Layer.mergeAll(
    D1WorkflowRunsLive(options.db),
    registry,
    D1AssetsLive(options.db),
    MarketDataSourcesLayer(options.sourceFor),
    options.artifacts,
  );
  const platform = localRunPlatform(
    (params, steps) =>
      executeWorkflowRun(params, steps, (program) =>
        program.pipe(Effect.provide(executorLayer), Effect.runPromise),
      ),
    options.platform,
  );
  const dependencies = {
    statusFor: unavailable("Pipeline status"),
    registryFor: unavailable("The symbol registry"),
    scheduleFor: unavailable("The legacy schedule"),
    downloadWorkflowFor: unavailableBinding("The legacy download workflow"),
    engineFor: unavailable("The calculation engine"),
    calculationsFor: unavailable("Calculations"),
    runWorkflowFor: unavailableBinding("Calculation runs"),
    portfoliosFor: () => D1PortfoliosLive(options.db),
    assetsFor: () => D1AssetsLive(options.db),
    workflowsFor: () => Layer.merge(D1WorkflowsLive(options.db), registry),
    workflowRunsFor: () =>
      Layer.merge(D1WorkflowRunsLive(options.db), options.artifacts),
    runPlatformFor: () => platform,
  } satisfies Dependencies;
  return { dependencies, platform };
};
