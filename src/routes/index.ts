import { Hono } from "hono";

import {
  type AccessKeys,
  remoteAccessKeys,
  requireManagementToken,
} from "$/auth";
import type { ServicesFor } from "$/dependencies";
import { type AppHandler, createAppRoutes } from "$/routes/app";
import { createAppApiRoutes } from "$/routes/app-api";
import { createAssetRoutes } from "$/routes/assets";
import { createDatasetRoutes } from "$/routes/datasets";
import { createDocsRoutes } from "$/routes/docs";
import { createPortfolioRoutes } from "$/routes/portfolios";
import { createRunRoutes } from "$/routes/runs";
import { createStepTypeRoutes, createWorkflowRoutes } from "$/routes/workflows";
import {
  createAssignmentRoutes,
  createWorkflowDefaultRoutes,
} from "$/routes/workflows/defaults";

/**
 * Every route on the hostname:
 *
 * - `/api/*`: the management API, for scripts and other apps (Bearer token).
 *   Cloudflare Access lets it through.
 * - `/app-api/*`: the JSON API the app's pages call from the browser.
 * - `/docs/*`: the docs site.
 * - everything else: the SvelteKit app.
 *
 * All but `/api` need an allowlisted Access user.
 */
export const createRoutes = (
  servicesFor: ServicesFor,
  appHandler: AppHandler,
  keysFor: AccessKeys = remoteAccessKeys,
) => {
  const api = new Hono<{ Bindings: CloudflareBindings }>();
  api.route("/assets", createAssetRoutes(servicesFor, requireManagementToken));
  api.route(
    "/portfolios",
    createPortfolioRoutes(servicesFor, requireManagementToken),
  );
  api.route(
    "/workflows",
    createWorkflowRoutes(servicesFor, requireManagementToken),
  );
  api.route(
    "/step-types",
    createStepTypeRoutes(servicesFor, requireManagementToken),
  );
  api.route(
    "/workflow-defaults",
    createWorkflowDefaultRoutes(servicesFor, requireManagementToken),
  );
  api.route(
    "/workflow-assignments",
    createAssignmentRoutes(servicesFor, requireManagementToken),
  );
  api.route("/runs", createRunRoutes(servicesFor, requireManagementToken));
  api.route(
    "/datasets",
    createDatasetRoutes(servicesFor, requireManagementToken),
  );
  api.all("*", (c) => c.json({ error: "Not found" }, 404));

  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.route("/api", api);
  app.route("/app-api", createAppApiRoutes(servicesFor, keysFor));
  app.route("/docs", createDocsRoutes(keysFor));
  // The dashboard used to live here; its pages are now at the top level.
  app.get("/dashboard", (c) => c.redirect("/", 302));
  app.get("/dashboard/*", (c) => c.redirect("/", 302));
  app.route("/", createAppRoutes(appHandler, keysFor));
  return app;
};
