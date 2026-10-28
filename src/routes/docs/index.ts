import { Hono } from "hono";

import { type AccessKeys, type AccessVariables, remoteAccessKeys, requireAccessUser } from "$/auth";

/**
 * The docs site: static files built from `docs/`, behind the same Cloudflare
 * Access check and allowlist as the dashboard.
 */
export const createDocsRoutes = (keysFor: AccessKeys = remoteAccessKeys) => {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AccessVariables }>();
  app.use("*", requireAccessUser(keysFor));
  app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
};
