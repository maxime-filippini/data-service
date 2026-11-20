import { Effect, type Layer, Result, Schema } from "effect";

import { AssetSymbolSchema } from "$/assets/contracts";
import { Assets } from "$/assets/store";
import { CalculationIdSchema } from "$/calculations/contracts";
import { DatasetPublicationStore } from "$/datasets/store";
import { isCronError, nextSlot, parseCron } from "$/calculations/cron";
import { Calculations } from "$/calculations/store";
import type { Calculation } from "$/calculations/views";
import {
  type Dependencies,
  dependencies as liveDependencies,
} from "$/dependencies";
import { scheduleView } from "$/market-data/schedule/operations";
import { ScheduleStore } from "$/market-data/schedule/store";
import { datasetProviders } from "$/market-data/schemas";
import { PipelineStatus } from "$/market-data/status";
import type { RunStatus, SymbolStatusView } from "$/market-data/status/views";
import { PortfolioIdSchema } from "$/portfolios/contracts";
import { Portfolios } from "$/portfolios/store";
import { WorkflowIdSchema } from "$/workflows/contracts";
import {
  inspectWorkflowById,
  subjectAssignments,
} from "$/workflows/operations";
import { RunIdSchema, RunStatusSchema } from "$/workflows/runs/contracts";
import { WorkflowRuns } from "$/workflows/runs/store";
import { Workflows } from "$/workflows/store";

import type * as Facade from "./app";
import type { PageData, SymbolCounts, UpcomingCalculation } from "./views";

/** How many ingestion runs a page of the runs list holds, as in the app's API. */
export const RUN_PAGE_SIZE = 50;

const RUN_STATUSES: readonly RunStatus[] = ["fetching", "completed", "failed"];

const HOME_LIST_SIZE = 5;

/** How many runs the runs page and the detail pages list. */
export const WORKFLOW_RUN_PAGE_SIZE = 50;

const RECENT_RUNS = 10;

export type * from "./views";

/** A page's data could not be loaded. `status` is the HTTP status to answer with. */
export class PageDataError extends Error {
  constructor(
    readonly status: 404 | 500,
    message: string,
  ) {
    super(message);
  }
}

const isUuid = (
  schema:
    | typeof CalculationIdSchema
    | typeof PortfolioIdSchema
    | typeof RunIdSchema
    | typeof WorkflowIdSchema,
  id: string,
) => Schema.is(schema)(id);

/** Run a program against one service's layer; a failure becomes a `PageDataError`. */
const runWith =
  <R>(layer: Layer.Layer<R>) =>
  async <A, E extends { readonly message: string; readonly kind?: string }>(
    program: Effect.Effect<A, E, R>,
  ): Promise<A> => {
    const result = await program.pipe(
      Effect.provide(layer),
      Effect.result,
      Effect.runPromise,
    );
    if (Result.isFailure(result)) {
      throw new PageDataError(
        result.failure.kind === "not_found" ? 404 : 500,
        result.failure.message,
      );
    }
    return result.success;
  };

export const countSymbols = (
  symbols: readonly SymbolStatusView[],
): SymbolCounts => ({
  total: symbols.length,
  scheduled: symbols.filter((s) => s.enabled).length,
  failedDownloads: symbols.filter((s) => s.latestRun?.status === "failed")
    .length,
  failedRebuilds: symbols.filter((s) => s.latestJob?.status === "failed")
    .length,
  neverDownloaded: symbols.filter((s) => s.lastCompletedRun === null).length,
});

export const upcomingCalculations = (
  calculations: readonly Calculation[],
  now: Date,
): UpcomingCalculation[] =>
  calculations
    .filter((c) => c.enabled)
    .flatMap((c) => {
      const schedule = parseCron(c.cron);
      const next = isCronError(schedule) ? null : nextSlot(schedule, now);
      return next === null
        ? []
        : [
            {
              id: c.id,
              name: c.name,
              type: c.type,
              cron: c.cron,
              nextRunAt: next.toISOString(),
            },
          ];
    })
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));

/** The page data (see `PageData`) on a request's bindings. */
export const pageData = (
  env: CloudflareBindings,
  dependencies: Dependencies = liveDependencies,
): PageData => {
  const status = runWith(dependencies.statusFor(env));
  const store = runWith(dependencies.scheduleFor(env));
  const portfolios = runWith(dependencies.portfoliosFor(env));
  const calculations = runWith(dependencies.calculationsFor(env));
  const assets = runWith(dependencies.assetsFor(env));
  const workflows = runWith(dependencies.workflowsFor(env));
  const workflowRuns = runWith(dependencies.workflowRunsFor(env));
  const datasets = runWith(dependencies.datasetsFor(env));

  const listSymbols = () =>
    status(PipelineStatus.use((s) => s.listSymbols({})));
  const schedule = (now: Date) => store(scheduleView(now));
  const scheduleRuns = (limit: number) =>
    store(ScheduleStore.use((s) => s.listRuns(limit)));
  const listPortfolios = () => portfolios(Portfolios.use((p) => p.list()));
  const listCalculations = () =>
    calculations(Calculations.use((c) => c.list()));

  return {
    runs: (filter) => {
      const runStatus = RUN_STATUSES.find((s) => s === filter.status);
      const symbol = filter.symbol?.trim().toUpperCase();
      return status(
        PipelineStatus.use((s) =>
          s.listRuns({
            ...(symbol ? { symbol } : {}),
            ...(runStatus === undefined ? {} : { status: runStatus }),
            limit: RUN_PAGE_SIZE,
          }),
        ),
      );
    },

    symbols: () => listSymbols(),

    options: () => ({ datasetProviders }),

    schedule: () => schedule(new Date()),

    scheduleRuns: (limit = 10) => scheduleRuns(limit),

    portfolios: () => listPortfolios(),

    portfolio: (id) => {
      if (!isUuid(PortfolioIdSchema, id))
        return Promise.reject(new PageDataError(404, "Portfolio not found"));
      return portfolios(Portfolios.use((p) => p.get(id)));
    },

    calculations: () => listCalculations(),

    assets: () => assets(Assets.use((a) => a.list())),

    asset: async (symbol) => {
      if (!Schema.is(AssetSymbolSchema)(symbol))
        throw new PageDataError(404, "Asset not found");
      const [asset, assignments, runs, publications] = await Promise.all([
        assets(Assets.use((a) => a.get(symbol))),
        workflows(subjectAssignments({ kind: "asset", symbol })),
        workflowRuns(
          WorkflowRuns.use((r) =>
            r.list({
              subject: { kind: "asset", id: symbol },
              limit: RECENT_RUNS,
            }),
          ),
        ),
        datasets(
          DatasetPublicationStore.use((p) =>
            p.list({ subject: { kind: "asset", id: symbol } }),
          ),
        ),
      ]);
      return { asset, assignments, runs, publications };
    },

    workflows: () => workflows(Workflows.use((w) => w.list())),

    workflow: async (id) => {
      if (!isUuid(WorkflowIdSchema, id))
        throw new PageDataError(404, "Workflow not found");
      const [inspected, runs] = await Promise.all([
        workflows(inspectWorkflowById(id)),
        workflowRuns(
          WorkflowRuns.use((r) =>
            r.list({ workflowId: id, limit: RECENT_RUNS }),
          ),
        ),
      ]);
      return { ...inspected, runs };
    },

    workflowRuns: (filter) => {
      const status = Schema.is(RunStatusSchema)(filter.status)
        ? filter.status
        : undefined;
      const symbol = filter.symbol?.trim().toUpperCase();
      return workflowRuns(
        WorkflowRuns.use((r) =>
          r.list({
            ...(status === undefined ? {} : { status }),
            ...(symbol ? { subject: { kind: "asset", id: symbol } } : {}),
            limit: WORKFLOW_RUN_PAGE_SIZE,
          }),
        ),
      );
    },

    workflowRun: async (id) => {
      if (!isUuid(RunIdSchema, id))
        throw new PageDataError(404, "Run not found");
      return workflowRuns(WorkflowRuns.use((r) => r.get(id)));
    },

    calculation: async (id, runLimit = 50) => {
      if (!isUuid(CalculationIdSchema, id))
        throw new PageDataError(404, "Calculation not found");
      const [calculation, runs] = await Promise.all([
        calculations(Calculations.use((c) => c.get(id))),
        calculations(Calculations.use((c) => c.listRuns(id, runLimit))),
      ]);
      return { calculation, runs };
    },

    home: async () => {
      const now = new Date();
      const [symbols, view, history, failed, owned, calcs] = await Promise.all([
        listSymbols(),
        schedule(now),
        scheduleRuns(HOME_LIST_SIZE),
        status(
          PipelineStatus.use((s) =>
            s.listRuns({ status: "failed", limit: HOME_LIST_SIZE }),
          ),
        ),
        listPortfolios(),
        listCalculations(),
      ]);
      const latestRuns = calcs
        .flatMap((c) =>
          c.lastRun === null ? [] : [{ ...c.lastRun, calculationName: c.name }],
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, HOME_LIST_SIZE);
      return {
        symbols: countSymbols(symbols),
        schedule: view,
        scheduleRuns: history,
        failedRuns: failed.runs,
        portfolioCount: owned.length,
        calculations: {
          total: calcs.length,
          enabled: calcs.filter((c) => c.enabled).length,
          latestRuns,
          upcoming: upcomingCalculations(calcs, now).slice(0, HOME_LIST_SIZE),
        },
      };
    },
  };
};

// The app compiles against ./app.ts instead of this module; keep them in step.
pageData satisfies typeof Facade.pageData;

PageDataError satisfies typeof Facade.PageDataError;
