import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { type AccessKeys, type AccessVariables, remoteAccessKeys, requireAccessUser } from "$/auth";

/**
 * The docs site: static files built from `docs/`, behind the same Cloudflare
 * Access check and allowlist as the app.
 */
export const createDocsRoutes = (keysFor: AccessKeys = remoteAccessKeys) => {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AccessVariables }>();
  app.use("*", requireAccessUser(keysFor));
  app.use("*", secureHeaders());
  app.get("*", async (c) => {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    // Copy the response so the security headers can be added to it.
    return new Response(asset.body, asset);
  });
  return app;
};
