import { Layer } from "effect";

import { D1AssetStoreLive } from "$/assets/d1";
import type { AssetStore } from "$/assets/store";
import { D1DatasetPublicationStoreLive } from "$/datasets/d1";
import { R2DatasetObjectStoreLive } from "$/datasets/r2";
import type {
  DatasetObjectStore,
  DatasetPublicationStore,
} from "$/datasets/store";
import {
  liveSourceFor,
  type MarketDataSources,
  MarketDataSourcesLayer,
} from "$/market-data/sources";
import {
  HttpPythonOperationsLive,
  type PythonOperations,
} from "$/operations/client";
import { D1PortfoliosLive } from "$/portfolios/d1";
import type { Portfolios } from "$/portfolios/store";
import { type RunArtifacts, R2RunArtifactsLive } from "$/workflows/artifacts";
import { D1WorkflowStoreLive } from "$/workflows/d1";
import { type StepRegistry, StepRegistryLive } from "$/workflows/registry";
import {
  type RunCoordinator,
  RunCoordinatorLive,
} from "$/workflows/runs/coordinator";
import { D1WorkflowRunsLive } from "$/workflows/runs/d1";
import { BindingRunLauncherLive } from "$/workflows/runs/launcher";
import type { WorkflowRuns } from "$/workflows/runs/store";
import type { WorkflowStore } from "$/workflows/store";

/**
 * Every service the application needs on a host, apart from the
 * per-instance Checkpointer: what routes, pages, the dispatch tick and run
 * instances run against.
 */
export type AppServices =
  | AssetStore
  | Portfolios
  | WorkflowStore
  | StepRegistry
  | WorkflowRuns
  | RunArtifacts
  | RunCoordinator
  | MarketDataSources
  | PythonOperations
  | DatasetPublicationStore
  | DatasetObjectStore;

/**
 * A host's services for one request or instance, from the Worker's
 * bindings. Each host has one: `cloudflareServices` here, and
 * `localWorkflowService(...).servicesFor` locally.
 */
export type ServicesFor = (env: CloudflareBindings) => Layer.Layer<AppServices>;

/**
 * The services on Cloudflare: D1 for records, R2 for run artifacts (raw
 * bucket, under `runs/`) and published datasets (processed bucket), the
 * live provider integrations, the Python engine container, and the run
 * Workflow binding for launching runs.
 */
export const cloudflareServices: ServicesFor = (env) => {
  const db = env.MARKET_DATA_DB;
  const adapters = Layer.mergeAll(
    D1AssetStoreLive(db),
    D1PortfoliosLive(db),
    D1WorkflowStoreLive(db),
    StepRegistryLive,
    D1WorkflowRunsLive(db),
    R2RunArtifactsLive(env.MARKET_DATA_BUCKET),
    BindingRunLauncherLive(env.WORKFLOW_RUNS),
    MarketDataSourcesLayer(liveSourceFor(env)),
    // One named container instance for Python operations.
    HttpPythonOperationsLive(
      env.CALCULATION_ENGINE.getByName("engine"),
      "http://engine",
    ),
    D1DatasetPublicationStoreLive(db),
    R2DatasetObjectStoreLive(env.PROCESSED_MARKET_DATA_BUCKET),
  );
  return Layer.provideMerge(RunCoordinatorLive, adapters);
};
