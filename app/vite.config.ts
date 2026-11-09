import adapter from "@sveltejs/adapter-cloudflare";
import { sveltekit } from "@sveltejs/kit/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** The Worker's modules (../src), which the pages' server-side loads use. */
const workerSrc = fileURLToPath(new URL("../src/", import.meta.url));

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({
        // Where to write the build; see the comments in that file.
        config: "wrangler.adapter.jsonc",
        // `vite dev` gets the real Worker's bindings and shares `wrangler
        // dev`'s local D1 database.
        platformProxy: { configPath: "../wrangler.jsonc", persist: { path: "../.wrangler/state/v3" } },
      }),
      csp: {
        mode: "auto",
        directives: {
          "default-src": ["self"],
          "img-src": ["self", "data:"],
          "object-src": ["none"],
          "base-uri": ["none"],
          "frame-ancestors": ["none"],
        },
      },
    }),
  ],
  resolve: {
    // The Worker's modules import each other as `$/…` (see ../tsconfig.json).
    // Subpath imports can't reach outside this package, so this is an alias.
    alias: [{ find: /^\$\//u, replacement: workerSrc }],
  },
  server: {
    // Changes go through the Worker's JSON API: run `pnpm dev` in the root
    // (wrangler dev on 8787, with the local Access bypass) alongside this.
    proxy: { "/app-api": "http://localhost:8787" },
  },
});
