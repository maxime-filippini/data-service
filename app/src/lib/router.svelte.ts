import { goto } from "$app/navigation";
import { page } from "$app/state";

export type View = "runs" | "symbols" | "portfolios" | "calculations" | "explore";

/** The query parameters of the current page, e.g. `?symbol=AAPL.US` on /runs. */
export const route = {
  get params() {
    return page.url.searchParams;
  },
};

/**
 * A link to a page. `id` opens a portfolio or calculation
 * (`/portfolios/<id>`); other params go in the query string.
 */
export const href = (view: View, params: Record<string, string | undefined> = {}) => {
  const { id, ...rest } = params;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(rest)) if (value) search.set(key, value);
  const path = id ? `/${view}/${encodeURIComponent(id)}` : `/${view}`;
  return `${path}${search.size > 0 ? `?${search}` : ""}`;
};

/**
 * Change the query string without adding a history entry, e.g. while
 * filtering. The page's server load reruns only if it reads those params.
 */
export const replace = (view: View, params: Record<string, string | undefined>) =>
  goto(href(view, params), { replace: true, reset: false });
