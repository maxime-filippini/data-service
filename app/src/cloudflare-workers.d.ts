// The Worker's bindings. Typed loosely here, since the Workers runtime types
// clash with the DOM's: `#lib/server/data` hands them to the Worker's own
// modules, which have the full types.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
