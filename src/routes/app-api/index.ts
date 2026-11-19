import { Hono, type MiddlewareHandler } from "hono";

import {
  type AccessKeys,
  type AccessVariables,
  remoteAccessKeys,
  requireAccessUser,
} from "$/auth";
import type { Dependencies } from "$/dependencies";
import type { DashboardUser } from "$/pages/views";
import { createAssetRoutes } from "$/routes/assets";
import { createDatasetRoutes } from "$/routes/datasets";
import { createPortfolioRoutes } from "$/routes/portfolios";
import { createRunRoutes } from "$/routes/runs";
import { createStepTypeRoutes, createWorkflowRoutes } from "$/routes/workflows";
import {
  createAssignmentRoutes,
  createWorkflowDefaultRoutes,
} from "$/routes/workflows/defaults";

/**
 * Hono context for app JSON routes: Cloudflare bindings plus the identity
 * set by Access middleware before any handler or mutation runs.
 */
type AppApiEnv = { Bindings: CloudflareBindings; Variables: AccessVariables };

/** Passes every request; the app's API has already checked Access. */
const accessChecked: MiddlewareHandler = (_, next) => next();

/**
 * Browsers send the Access cookie with cross-site requests too, so changes
 * must come from the app's own pages. JSON bodies already force a CORS
 * preflight, which nothing answers; this also covers bodiless POSTs.
 */
const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    const sameOrigin =
      origin === new URL(c.req.url).origin ||
      c.req.header("Sec-Fetch-Site") === "same-origin";
    if (!sameOrigin)
      return c.json({ error: "Cross-site requests are not allowed" }, 403);
  }
  await next();
};

/**
 * The app's JSON API, which its pages call from the browser (mounted at
 * `/app-api`). Every request needs a Cloudflare Access user on the allowlist,
 * and every mutation must come from the app's own origin. Business logic is
 * shared with the management API through the same route modules.
 */
export const createAppApiRoutes = (
  dependencies: Dependencies,
  keysFor: AccessKeys = remoteAccessKeys,
) => {
  const app = new Hono<AppApiEnv>();

  app.use("*", requireAccessUser(keysFor));
  app.use("*", requireSameOrigin);
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control"))
      c.header("Cache-Control", "no-store");
  });

  app.get("/me", (c) => c.json<DashboardUser>({ email: c.get("accessEmail") }));

  app.route(
    "/assets",
    createAssetRoutes(dependencies.assetsFor, accessChecked),
  );
  app.route(
    "/portfolios",
    createPortfolioRoutes(dependencies.portfoliosFor, accessChecked),
  );
  app.route(
    "/workflows",
    createWorkflowRoutes(dependencies.workflowsFor, accessChecked),
  );
  app.route(
    "/step-types",
    createStepTypeRoutes(dependencies.workflowsFor, accessChecked),
  );
  app.route(
    "/workflow-defaults",
    createWorkflowDefaultRoutes(dependencies.workflowsFor, accessChecked),
  );
  app.route(
    "/workflow-assignments",
    createAssignmentRoutes(dependencies.workflowsFor, accessChecked),
  );
  app.route("/workflow-runs", createRunRoutes(dependencies, accessChecked));
  app.route("/publications", createDatasetRoutes(dependencies, accessChecked));

  app.all("*", (c) => c.json({ error: "Not found" }, 404));

  return app;
};
