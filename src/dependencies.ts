import { Layer } from "effect";

import { D1AssetsLive } from "$/assets/d1";
import { D1CalculationsLive } from "$/calculations/d1";
import { EngineLive } from "$/calculations/engine";
import type { RunWorkflow } from "$/calculations/runs";
import { D1ScheduleStoreLive } from "$/market-data/schedule/d1";
import type { ScheduleWorkflow } from "$/market-data/schedule/operations";
import { D1PipelineStatusLive } from "$/market-data/status/d1";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { D1PortfoliosLive } from "$/portfolios/d1";
import { D1WorkflowsLive } from "$/workflows/d1";
import { StepRegistryLive } from "$/workflows/registry";

/**
 * Select real adapters using the current request's Cloudflare bindings.
 * Routes and page reads share this wiring; tests supply the same shape with
 * local databases and engine/Workflow stand-ins.
 */
export const dependencies = {
  statusFor: (env: CloudflareBindings) =>
    D1PipelineStatusLive(env.MARKET_DATA_DB),
  registryFor: (env: CloudflareBindings) =>
    D1SymbolRegistryLive(env.MARKET_DATA_DB),
  scheduleFor: (env: CloudflareBindings) =>
    D1ScheduleStoreLive(env.MARKET_DATA_DB),
  downloadWorkflowFor: (env: CloudflareBindings): ScheduleWorkflow =>
    env.SCHEDULED_DOWNLOADS,
  portfoliosFor: (env: CloudflareBindings) =>
    D1PortfoliosLive(env.MARKET_DATA_DB),
  // One engine instance for now, like the processor.
  engineFor: (env: CloudflareBindings) =>
    EngineLive(env.CALCULATION_ENGINE.getByName("engine")),
  calculationsFor: (env: CloudflareBindings) =>
    D1CalculationsLive(env.MARKET_DATA_DB),
  runWorkflowFor: (env: CloudflareBindings): RunWorkflow =>
    env.CALCULATION_RUNS,
  assetsFor: (env: CloudflareBindings) => D1AssetsLive(env.MARKET_DATA_DB),
  // Definitions are validated and inspected against the code-owned registry.
  workflowsFor: (env: CloudflareBindings) =>
    Layer.merge(D1WorkflowsLive(env.MARKET_DATA_DB), StepRegistryLive),
};

/**
 * Dependency-factory shape shared by route construction and page reads.
 * Each factory selects an adapter from request bindings; tests supply local
 * implementations with the same shape. This is wiring, not persisted configuration.
 */
export type Dependencies = typeof dependencies;
