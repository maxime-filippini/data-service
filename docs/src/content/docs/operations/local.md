---
title: Local development
description: Running the Worker, the app, the docs and the containers on your machine.
---

## Setup

```sh
pnpm install
cp .dev.vars.example .dev.vars   # then fill in real values
pnpm db:migrate:local
pnpm dev
```

`pnpm dev` builds the app and this site, then runs the Worker on
`http://localhost:8787`:

| URL | What |
| --- | --- |
| `http://localhost:8787/` | The app: home page and dashboard |
| `http://localhost:8787/api/` | Management API |
| `http://localhost:8787/docs/` | These docs |

`pnpm dev` skips the Access check on the app and docs by passing
`--var DASHBOARD_LOCAL_BYPASS:true`; the Worker honors it only for requests to
localhost. It's a flag rather than a `.dev.vars` line because wrangler only
loads the secrets declared in `wrangler.jsonc` from `.dev.vars`. `pnpm dev`
also passes `--local-upstream localhost:8787`: without it, `wrangler dev` gives
the Worker the custom domain from `wrangler.jsonc` as the request's host, and
the bypass never applies.

### Hot reload

```sh
pnpm dev               # the Worker, for the app's JSON API (/app-api)
pnpm app:dev           # http://localhost:5173/
pnpm docs:dev          # http://localhost:4321/docs/
```

`pnpm app:dev` runs SvelteKit's dev server. Its pages load their data from the
same local D1 database as `pnpm dev`, and it forwards `/app-api` to the Worker
on 8787, so run both. It always signs you in as `local@localhost`.

## Limits of `pnpm dev`

`pnpm dev` can't run the full pipeline: the containers read real R2 while the
local Worker writes to simulated buckets. To try the app without them:

```sh
pnpm dev --enable-containers=false
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
pnpm app:check
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
