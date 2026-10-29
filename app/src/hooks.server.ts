import { dev } from "$app/env";
import { json } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";

/** Set by the Worker once it has checked Cloudflare Access (src/routes/app). */
const ACCESS_EMAIL_HEADER = "X-Access-Email";

/**
 * The Worker only hands SvelteKit requests from an allowlisted Access user,
 * with the user's email in a header it sets itself. `vite dev` has no Worker
 * in front, so it runs as a local user.
 */
export const handle: Handle = ({ event, resolve }) => {
  const email = event.request.headers.get(ACCESS_EMAIL_HEADER) ?? (dev ? "local@localhost" : null);
  if (email === null) return json({ error: "Sign in through Cloudflare Access" }, { status: 401 });
  event.locals.user = { email };
  return resolve(event);
};
