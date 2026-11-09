import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { type AccessKeys, type AccessVariables, remoteAccessKeys, requireAccessUser } from "$/auth";

/**
 * The header that tells the app who the Access user is. The Worker sets it
 * after checking Access and drops any copy the client sent.
 */
export const ACCESS_EMAIL_HEADER = "X-Access-Email";

/** SvelteKit's request handler, as built by adapter-cloudflare. */
export interface AppHandler {
  readonly fetch: (request: Request, env: CloudflareBindings) => Response | Promise<Response>;
}

/**
 * The SvelteKit app (`app/`): the home page, the dashboard pages and their
 * static files. Every request, static files included, needs an allowlisted
 * Cloudflare Access user, whose email the app gets in `ACCESS_EMAIL_HEADER`.
 * SvelteKit sets the pages' Content-Security-Policy itself, since it needs a
 * nonce for its inline startup script.
 */
export const createAppRoutes = (handler: AppHandler, keysFor: AccessKeys = remoteAccessKeys) => {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AccessVariables }>();
  app.use("*", requireAccessUser(keysFor));
  app.use("*", secureHeaders());
  app.all("*", async (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set(ACCESS_EMAIL_HEADER, c.get("accessEmail"));
    const response = await handler.fetch(new Request(c.req.raw, { headers }), c.env);
    // Copy the response so the security headers can be added to it.
    return new Response(response.body, response);
  });
  return app;
};
