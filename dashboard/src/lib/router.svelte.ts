// Hash routes, such as #/runs?symbol=AAPL.US, so the Worker only serves one page.

export type View = "runs" | "symbols";

const parse = () => {
  const [path = "", search = ""] = window.location.hash.replace(/^#\/?/u, "").split("?");
  const view: View = path === "symbols" ? "symbols" : "runs";
  return { view, params: new URLSearchParams(search) };
};

let current = $state(parse());
window.addEventListener("hashchange", () => (current = parse()));

export const route = {
  get view() {
    return current.view;
  },
  get params() {
    return current.params;
  },
};

export const href = (view: View, params: Record<string, string | undefined> = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return `#/${view}${search.size > 0 ? `?${search}` : ""}`;
};

/** Update the URL without adding a history entry, e.g. while typing in a filter. */
export const replace = (view: View, params: Record<string, string | undefined>) => {
  history.replaceState(null, "", href(view, params));
  current = parse();
};
