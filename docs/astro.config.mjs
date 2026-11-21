import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";

// Served at /docs/. `pnpm build` copies dist/ to ../dist/docs/ next to the
// app's files for the Worker's assets. Astro builds inside this package so its
// prerender step resolves this package's dependencies, not the root's.
export default defineConfig({
  site: "https://data-service.maximefilippini.me",
  base: "/docs",
  trailingSlash: "always",
  integrations: [
    // Before Starlight, so ```mermaid blocks become diagrams, not code.
    mermaid({ theme: "neutral", autoTheme: true }),
    starlight({
      title: "Data service",
      description:
        "Ownership guide for the workflow-based market-data and portfolio service.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/maxime-filippini/data-service",
        },
      ],
      sidebar: [
        "index",
        "concepts",
        "architecture",
        "maintaining",
        {
          label: "Workflows",
          items: [
            "workflows/definitions",
            "workflows/portfolios",
            "workflows/runs",
            "workflows/datasets",
          ],
        },
        {
          label: "Reference",
          items: [
            "reference/api",
            "reference/data-model",
            "reference/storage",
            "reference/containers",
          ],
        },
        {
          label: "Operations",
          items: [
            "operations/dashboard",
            "operations/local",
            "operations/deploying",
            "operations/workflow-smoke",
            "operations/workflow-cutover",
          ],
        },
      ],
    }),
  ],
});
