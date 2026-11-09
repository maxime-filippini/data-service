import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";

import { PageDataError, pageData } from "$/pages";

/** The Worker's read-only page data (src/pages), on this request's bindings. */
export const data = () => pageData(env as never);

/** Wait for a page's data, turning a failure into SvelteKit's error page. */
export const loaded = async <T>(promise: Promise<T>): Promise<T> => {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof PageDataError) error(cause.status, cause.message);
    throw cause;
  }
};
