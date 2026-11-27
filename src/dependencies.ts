import { Layer } from "effect";

import { D1AssetsLive } from "$/assets/d1";
import { D1DatasetPublicationStoreLive } from "$/datasets/d1";
import { R2DatasetObjectStoreLive } from "$/datasets/r2";
import { D1PortfoliosLive } from "$/portfolios/d1";
import { R2RunArtifactsLive } from "$/workflows/artifacts";
import { D1WorkflowsLive } from "$/workflows/d1";
import { StepRegistryLive } from "$/workflows/registry";
import type { RunPlatform } from "$/workflows/runs/contracts";
import { D1WorkflowRunsLive } from "$/workflows/runs/d1";

/**
 * Select real adapters using the current request's Cloudflare bindings.
 * Routes and page reads share this wiring; tests supply the same shape with
 * local databases and Workflow stand-ins.
 */
export const dependencies = {
  assetsFor: (env: CloudflareBindings) => D1AssetsLive(env.MARKET_DATA_DB),
  portfoliosFor: (env: CloudflareBindings) =>
    D1PortfoliosLive(env.MARKET_DATA_DB),
  // Definitions are validated and inspected against the code-owned registry.
  workflowsFor: (env: CloudflareBindings) =>
    Layer.merge(D1WorkflowsLive(env.MARKET_DATA_DB), StepRegistryLive),
  // Run records in D1; run artifacts under `runs/` in the raw bucket.
  workflowRunsFor: (env: CloudflareBindings) =>
    Layer.merge(
      D1WorkflowRunsLive(env.MARKET_DATA_DB),
      R2RunArtifactsLive(env.MARKET_DATA_BUCKET),
    ),
  runPlatformFor: (env: CloudflareBindings): RunPlatform => env.WORKFLOW_RUNS,
  // Publication metadata in D1; published objects in the processed bucket.
  datasetsFor: (env: CloudflareBindings) =>
    Layer.merge(
      D1DatasetPublicationStoreLive(env.MARKET_DATA_DB),
      R2DatasetObjectStoreLive(env.PROCESSED_MARKET_DATA_BUCKET),
    ),
};

/**
 * Dependency-factory shape shared by route construction and page reads.
 * Each factory selects an adapter from request bindings; tests supply local
 * implementations with the same shape. This is wiring, not persisted configuration.
 */
export type Dependencies = typeof dependencies;
