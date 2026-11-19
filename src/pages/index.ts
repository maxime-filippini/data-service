import { Effect, type Layer, Result, Schema } from "effect";

import { AssetSymbolSchema } from "$/assets/contracts";
import { Assets } from "$/assets/store";
import { DatasetPublicationStore } from "$/datasets/store";
import {
  type Dependencies,
  dependencies as liveDependencies,
} from "$/dependencies";
import { PortfolioIdSchema } from "$/portfolios/contracts";
import { Portfolios } from "$/portfolios/store";
import { WorkflowIdSchema } from "$/workflows/contracts";
import {
  inspectWorkflowById,
  subjectAssignments,
} from "$/workflows/operations";
import {
  RunIdSchema,
  RunStatusSchema,
  RunTriggerSchema,
} from "$/workflows/runs/contracts";
import { WorkflowRuns } from "$/workflows/runs/store";
import { Workflows } from "$/workflows/store";

import type * as Facade from "./app";
import type { PageData } from "./views";

const HOME_LIST_SIZE = 5;

/** How many runs the runs page lists. */
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
    typeof PortfolioIdSchema | typeof RunIdSchema | typeof WorkflowIdSchema,
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

/** The page data (see `PageData`) on a request's bindings. */
export const pageData = (
  env: CloudflareBindings,
  dependencies: Dependencies = liveDependencies,
): PageData => {
  const assets = runWith(dependencies.assetsFor(env));
  const portfolios = runWith(dependencies.portfoliosFor(env));
  const workflows = runWith(dependencies.workflowsFor(env));
  const workflowRuns = runWith(dependencies.workflowRunsFor(env));
  const datasets = runWith(dependencies.datasetsFor(env));

  const listAssets = () => assets(Assets.use((a) => a.list()));
  const listPortfolios = () => portfolios(Portfolios.use((p) => p.list()));
  const listWorkflows = () => workflows(Workflows.use((w) => w.list()));
  const listPublications = () =>
    datasets(DatasetPublicationStore.use((p) => p.list({})));
  const getPortfolio = async (id: string) => {
    if (!isUuid(PortfolioIdSchema, id))
      throw new PageDataError(404, "Portfolio not found");
    return portfolios(Portfolios.use((p) => p.get(id)));
  };

  return {
    home: async () => {
      const [allAssets, owned, definitions, recentRuns, allPublications] =
        await Promise.all([
          listAssets(),
          listPortfolios(),
          listWorkflows(),
          workflowRuns(
            WorkflowRuns.use((r) => r.list({ limit: HOME_LIST_SIZE })),
          ),
          listPublications(),
        ]);
      const recentPublications = [...allPublications]
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, HOME_LIST_SIZE);
      return {
        assets: {
          total: allAssets.length,
          enabled: allAssets.filter((asset) => asset.enabled).length,
        },
        portfolioCount: owned.length,
        workflows: {
          total: definitions.length,
          enabled: definitions.filter((definition) => definition.enabled)
            .length,
          definitions,
        },
        recentRuns,
        publications: {
          total: allPublications.length,
          recent: recentPublications,
        },
      };
    },

    assets: listAssets,

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

    portfolios: listPortfolios,

    portfolio: getPortfolio,

    portfolioDetail: async (id) => {
      const portfolio = await getPortfolio(id);
      const [assignments, runs, publications] = await Promise.all([
        workflows(subjectAssignments({ kind: "portfolio", id })),
        workflowRuns(
          WorkflowRuns.use((r) =>
            r.list({
              subject: { kind: "portfolio", id },
              limit: RECENT_RUNS,
            }),
          ),
        ),
        datasets(
          DatasetPublicationStore.use((p) =>
            p.list({ subject: { kind: "portfolio", id } }),
          ),
        ),
      ]);
      return { portfolio, assignments, runs, publications };
    },

    workflows: listWorkflows,

    workflowDefaults: () => workflows(Workflows.use((w) => w.listDefaults())),

    workflow: async (id) => {
      if (!isUuid(WorkflowIdSchema, id))
        throw new PageDataError(404, "Workflow not found");
      const [inspected, defaults, runs] = await Promise.all([
        workflows(inspectWorkflowById(id)),
        workflows(Workflows.use((w) => w.listDefaults())),
        workflowRuns(
          WorkflowRuns.use((r) =>
            r.list({ workflowId: id, limit: RECENT_RUNS }),
          ),
        ),
      ]);
      return {
        ...inspected,
        isDefault: defaults.some((entry) => entry.workflowId === id),
        runs,
      };
    },

    workflowRuns: (filter) => {
      const status = Schema.is(RunStatusSchema)(filter.status)
        ? filter.status
        : undefined;
      const trigger = Schema.is(RunTriggerSchema)(filter.trigger)
        ? filter.trigger
        : undefined;
      const symbol = filter.symbol?.trim().toUpperCase();
      return workflowRuns(
        WorkflowRuns.use((r) =>
          r.list({
            ...(status === undefined ? {} : { status }),
            ...(trigger === undefined ? {} : { trigger }),
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

    publications: listPublications,
  };
};

// The app compiles against ./app.ts instead of this module; keep them in step.
pageData satisfies typeof Facade.pageData;

PageDataError satisfies typeof Facade.PageDataError;
