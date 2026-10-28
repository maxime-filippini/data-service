import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";

// Served at /docs/. `pnpm build` copies dist/ to ../dist/docs/ next to the
// dashboard for the Worker's assets. Astro builds inside this package so its
// prerender step resolves this package's dependencies, not the root's.
export default defineConfig({
  site: "https://data-service.maxime-filippini.workers.dev",
  base: "/docs",
  trailingSlash: "always",
  integrations: [
    // Before Starlight, so ```mermaid blocks become diagrams, not code.
    mermaid({ theme: "neutral", autoTheme: true }),
    starlight({
      title: "Data service",
      description: "How the market-data and calculation service works.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/maxime-filippini/data-service" },
      ],
      sidebar: [
        "index",
        "concepts",
        "architecture",
        { label: "Market data", items: ["pipeline/schedule", "pipeline/ingestion", "pipeline/processing"] },
        {
          label: "Calculations",
          items: ["calculations/portfolios", "calculations/runs", "calculations/scheduling", "calculations/types"],
        },
        {
          label: "Reference",
          items: ["reference/api", "reference/data-model", "reference/storage", "reference/containers"],
        },
        { label: "Operations", items: ["operations/dashboard", "operations/local", "operations/deploying"] },
      ],
    }),
  ],
});
