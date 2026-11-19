import { Hono } from "hono";

import {
  type AccessKeys,
  remoteAccessKeys,
  requireManagementToken,
} from "$/auth";
import type { Dependencies } from "$/dependencies";
import { type AppHandler, createAppRoutes } from "$/routes/app";
import { createAppApiRoutes } from "$/routes/app-api";
import { createAssetRoutes } from "$/routes/assets";
import {
  createCalculateRoutes,
  createCalculationTypeRoutes,
} from "$/routes/calculate";
import { createCalculationRoutes } from "$/routes/calculations";
import { createDatasetRoutes } from "$/routes/datasets";
import { createDocsRoutes } from "$/routes/docs";
import { createIngestionRoutes } from "$/routes/ingestions";
import { createPortfolioRoutes } from "$/routes/portfolios";
import { createRunRoutes } from "$/routes/runs";
import { createScheduleRoutes } from "$/routes/schedule";
import { createSymbolRoutes } from "$/routes/symbols";
import { createStepTypeRoutes, createWorkflowRoutes } from "$/routes/workflows";

/**
 * Every route on the hostname:
 *
 * - `/api/*`: the management API, for scripts and other apps (Bearer token).
 *   Cloudflare Access lets it through.
 * - `/app-api/*`: the JSON API the app's pages call from the browser.
 * - `/docs/*`: the docs site.
 * - everything else: the SvelteKit app (home page and dashboard).
 *
 * All but `/api` need an allowlisted Access user.
 */
export const createRoutes = (
  dependencies: Dependencies,
  appHandler: AppHandler,
  keysFor: AccessKeys = remoteAccessKeys,
) => {
  const api = new Hono<{ Bindings: CloudflareBindings }>();
  api.route(
    "/symbols",
    createSymbolRoutes(dependencies.registryFor, requireManagementToken),
  );
  api.route(
    "/ingestions",
    createIngestionRoutes(dependencies.registryFor, requireManagementToken),
  );
  api.route(
    "/schedule",
    createScheduleRoutes(dependencies, requireManagementToken),
  );
  api.route(
    "/portfolios",
    createPortfolioRoutes(dependencies.portfoliosFor, requireManagementToken),
  );
  api.route(
    "/calculation-types",
    createCalculationTypeRoutes(dependencies.engineFor, requireManagementToken),
  );
  api.route(
    "/calculate",
    createCalculateRoutes(dependencies, requireManagementToken),
  );
  api.route(
    "/calculations",
    createCalculationRoutes(dependencies, requireManagementToken),
  );
  api.route(
    "/assets",
    createAssetRoutes(dependencies.assetsFor, requireManagementToken),
  );
  api.route(
    "/workflows",
    createWorkflowRoutes(dependencies.workflowsFor, requireManagementToken),
  );
  api.route(
    "/step-types",
    createStepTypeRoutes(dependencies.workflowsFor, requireManagementToken),
  );
  api.route("/runs", createRunRoutes(dependencies, requireManagementToken));
  api.route(
    "/datasets",
    createDatasetRoutes(dependencies, requireManagementToken),
  );
  api.all("*", (c) => c.json({ error: "Not found" }, 404));

  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.route("/api", api);
  app.route("/app-api", createAppApiRoutes(dependencies, keysFor));
  app.route("/docs", createDocsRoutes(keysFor));
  // The dashboard used to live here; its pages are now at the top level.
  app.get("/dashboard", (c) => c.redirect("/", 302));
  app.get("/dashboard/*", (c) => c.redirect("/", 302));
  app.route("/", createAppRoutes(appHandler, keysFor));
  return app;
};
