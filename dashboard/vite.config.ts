import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Built into dist/dashboard/ so the Worker's assets serve it at /dashboard/.
export default defineConfig({
  base: "/dashboard/",
  plugins: [svelte()],
  build: {
    outDir: "dist/dashboard",
    emptyOutDir: true,
  },
  server: {
    // `pnpm dev` in the root runs the Worker on 8787 with the local bypass.
    proxy: { "/dashboard/api": "http://localhost:8787" },
  },
});
