// What the SvelteKit app sees of `$/pages` when it typechecks: its tsconfig
// maps `$/pages` here, because the real module (./index.ts) pulls in the
// Worker's modules, which need the Workers runtime types, and those clash with
// the DOM types the app's pages use. Vite still bundles ./index.ts. The checks
// at the end of ./index.ts keep the two in step.

import type { PageData } from "./views";

export type * from "./views";

/** The page data on a request's bindings (`env` from `cloudflare:workers`). */
export declare const pageData: (env: never) => PageData;

/** A page's data could not be loaded. `status` is the HTTP status to answer with. */
export declare class PageDataError extends Error {
  readonly status: 404 | 500;
  constructor(status: 404 | 500, message: string);
}
