---
title: Local development
description: Running the end-to-end fixture workflow, Worker, app, docs and Python service locally.
---

## End-to-end local scenario (recommended first step)

```sh
pnpm install
pnpm workflow:fixture
```

This runs the complete asset and portfolio workflow path locally without
Cloudflare credentials, EODHD tokens, or wrangler:

1. Starts the real Python operation service (`containers/engine/`) with `uv` on
   localhost.
2. Creates a local SQLite database with all real D1 migrations.
3. Calls the real management API routes to create assets, a daily EOD prices
   workflow, a changing-holdings portfolio, and a portfolio volatility
   workflow.
4. Executes both workflows through the real executor and Python HTTP
   operations, writing inspectable files into `.local/workflow-fixture/`.

Pass `--scheduled` to exercise daily UTC dispatch (`scheduledWorkflowTick`).
See [Running locally against fixtures](/docs/workflows/runs/#running-locally-against-fixtures)
for every output file and CLI option.

## Local Worker, app and docs

```sh
cp .dev.vars.example .dev.vars   # fill in local values
pnpm db:migrate:local
pnpm dev
```

`pnpm dev` builds the app and docs, then starts the Worker on
`http://localhost:8787`:

| URL                           | What               |
| ----------------------------- | ------------------ |
| `http://localhost:8787/`      | SvelteKit app      |
| `http://localhost:8787/api/`  | Management API     |
| `http://localhost:8787/docs/` | Documentation site |

`pnpm dev` passes `--var DASHBOARD_LOCAL_BYPASS:true --local-upstream localhost:8787`
so localhost requests skip Cloudflare Access checks.

### Hot reload

```sh
pnpm dev        # Worker + /app-api on :8787
pnpm app:dev    # SvelteKit dev server on http://localhost:5173/
pnpm docs:dev   # Astro Starlight dev server on http://localhost:4321/docs/
```

### Limits of `pnpm dev`

`wrangler dev` simulates R2 locally while Cloudflare Containers talk to real R2
over S3, so `pnpm dev` is best for UI/route iteration (use
`pnpm dev --enable-containers=false` if Docker is not running). For local
cross-language execution, use `pnpm workflow:fixture` and `pnpm test`; for real
Cloudflare Workflow checkpoint/replay verification, use the
[Cloudflare smoke test](/docs/operations/workflow-smoke/).

## Python service on its own

```sh
cd containers/engine
uv sync
uv run pytest
uv run engine operations
uv run engine export-schemas
uv run uvicorn data_service_engine.app:app --port 8080
```

On CPUs without AVX2, use `uv run --with 'polars[rtcompat]' pytest`.

## Full verification checks

```sh
pnpm operations:check
pnpm format:check
pnpm typecheck
pnpm test
pnpm workflow:fixture
pnpm engine:test
pnpm engine:lint
pnpm app:check
pnpm --filter app build
pnpm docs:build
```

## Editing these docs

Pages are Markdown/MDX under `docs/src/content/docs/`; the sidebar is in
`docs/astro.config.mjs`. Diagrams use fenced ` ```mermaid ` blocks. Link
between pages with absolute paths under `/docs/`.
