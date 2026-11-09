import { D1CalculationsLive } from "$/calculations/d1";
import { EngineLive } from "$/calculations/engine";
import { D1ScheduleStoreLive } from "$/market-data/schedule/d1";
import { D1PipelineStatusLive } from "$/market-data/status/d1";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { D1PortfoliosLive } from "$/portfolios/d1";

/** What the management API, the app's JSON API and its pages share. */
export const services = {
  statusFor: (env: CloudflareBindings) => D1PipelineStatusLive(env.MARKET_DATA_DB),
  registryFor: (env: CloudflareBindings) => D1SymbolRegistryLive(env.MARKET_DATA_DB),
  storeFor: (env: CloudflareBindings) => D1ScheduleStoreLive(env.MARKET_DATA_DB),
  workflowFor: (env: CloudflareBindings) => env.SCHEDULED_DOWNLOADS,
  portfoliosFor: (env: CloudflareBindings) => D1PortfoliosLive(env.MARKET_DATA_DB),
  // One engine instance for now, like the processor.
  engineFor: (env: CloudflareBindings) => EngineLive(env.CALCULATION_ENGINE.getByName("engine")),
  calculationsFor: (env: CloudflareBindings) => D1CalculationsLive(env.MARKET_DATA_DB),
  runWorkflowFor: (env: CloudflareBindings) => env.CALCULATION_RUNS,
};

export type Services = typeof services;
