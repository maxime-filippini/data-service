---
title: Local development
description: Running the Worker, dashboard, docs and containers on your machine.
---

## Setup

```sh
pnpm install
cp .dev.vars.example .dev.vars   # then fill in real values
pnpm db:migrate:local
pnpm dev
```

`pnpm dev` builds the dashboard and this site, then runs the Worker on
`http://localhost:8787`:

| URL | What |
| --- | --- |
| `http://localhost:8787/` | Management API |
| `http://localhost:8787/dashboard/` | Dashboard |
| `http://localhost:8787/docs/` | These docs |

Set `DASHBOARD_LOCAL_BYPASS=true` in `.dev.vars` to skip the Access check on
the dashboard and docs; it only works for requests to localhost.

### Hot reload

```sh
pnpm dev               # the Worker, for the dashboard's API
pnpm dashboard:dev     # http://localhost:5173/dashboard/
pnpm docs:dev          # http://localhost:4321/docs/
```

## Limits of `pnpm dev`

`pnpm dev` can't run the full pipeline: the containers read real R2 while the
local Worker writes to simulated buckets. To try the dashboard without them:

```sh
pnpm exec wrangler dev --enable-containers=false
```

Pages that need the engine (calculation types, saving params, runs) show its
error. For end-to-end tests, push a branch and use the
[dev environment](/docs/operations/deploying/#dev-environment).

## Containers on their own

```sh
cd containers/processor   # or containers/engine
uv sync
uv run pytest
uv run uvicorn data_service_processor.app:app --port 8080   # data_service_engine.app:app for the engine
```

On CPUs without AVX2, polars needs its compatibility runtime:
`uv run --with 'polars[rtcompat]' pytest`.

## Checks

```sh
pnpm test
pnpm typecheck
pnpm dashboard:check
pnpm docs:build
pnpm processor:test     # needs uv
pnpm processor:lint
pnpm engine:test        # needs uv
pnpm engine:lint
```

## Editing these docs

The site is [Astro Starlight](https://starlight.astro.build) in `docs/`. Pages
are Markdown in `docs/src/content/docs/`; the sidebar is in
`docs/astro.config.mjs`. Diagrams are fenced ` ```mermaid ` blocks, rendered
in the browser. Link between pages with absolute paths under `/docs/`.
