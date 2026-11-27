# Workflow operation engine

The single Python container for the data-service Worker ([README](../../README.md)).
It exposes workflow operations such as price normalization and portfolio ex-ante
volatility over one uniform HTTP contract. The Worker owns assets, portfolios,
workflow definitions, runs, scheduling and publication in D1 and R2; this
service only executes stateless operations over run artifacts and published
datasets.

See [datasets and Python operations](../../docs/src/content/docs/workflows/datasets.md)
and the [maintainer guide](../../docs/src/content/docs/maintaining.md).

## Contract

Only the Worker calls the container, so there is no authentication layer here.

| Endpoint                  | Purpose                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`             | Liveness probe (`{"status": "ok"}`).                                                                                                           |
| `GET /operations`         | Each registered operation's name, description and request/response JSON Schemas.                                                               |
| `POST /operations/{name}` | Runs one operation with `{execution: {runId, stepId}, inputs, params}`. Returns small JSON or `{error: {kind, message, issues}}` with non-2xx. |

Failures are never hidden behind HTTP `200`:

- `404` (`terminal`): unknown operation name.
- `422` (`terminal`): invalid request payload or deterministic domain failure (missing prices, insufficient history, invalid envelope).
- `503` / `500` (`transient`): storage or unexpected failure; the Worker retries within its bounded policy.

## Adding an operation

1. Write a module in `src/data_service_engine/operations/` with Pydantic `Contract`
   models for `inputs`, `params`, request (`OperationRequest` subclass) and
   response, a function `run(request, artifacts) -> response`, and an
   `OPERATION = Operation(...)`.
2. Register it explicitly in `operations/registry.py`.
3. Write any large output under `run_artifact_id(request.execution, ...)` so a
   repeated call after an uncertain HTTP response replaces the same object.
4. Raise `TerminalError` for invalid inputs or domain errors, and `TransientError`
   for temporary storage failures.
5. Run `pnpm operations:generate` from the repository root to update
   `src/operations/schemas.json` and `src/operations/contracts.generated.ts`.
6. Register a corresponding TypeScript step type in `src/workflows/registry/`.

## Configuration

Workflow operations read and write run artifacts in one of two places:

| Variable               | Purpose                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `ARTIFACT_ROOT`        | Local directory holding `runs/…` as files (takes precedence over R2 when set)         |
| `PROCESSED_ROOT`       | Local directory holding published datasets (`dataset=prices_eod/…`)                   |
| `ARTIFACT_BUCKET`      | R2 bucket holding `runs/…` (in production, `raw-market-data`, from `RAW_BUCKET_NAME`) |
| `PROCESSED_BUCKET`     | R2 bucket holding published datasets (`processed-market-data`)                        |
| `R2_ENDPOINT_URL`      | `https://<account-id>.r2.cloudflarestorage.com`                                       |
| `R2_ACCESS_KEY_ID`     | R2 S3 access key                                                                      |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret key                                                                      |

Buckets have no defaults so a misconfigured deployment fails instead of touching
production data.

## Run locally

```sh
uv sync
uv run pytest                     # on CPUs without AVX: uv run --with 'polars[rtcompat]' pytest
uv run engine operations          # list registered operations and their JSON Schemas
uv run engine export-schemas      # export operation contracts as JSON Schema
uv run uvicorn data_service_engine.app:app --port 8080
```

Cloudflare requires a `linux/amd64` image:

```sh
docker build --platform linux/amd64 -t calculation-engine .
```

## Verification

From the repo root:

```sh
pnpm operations:check
pnpm engine:test
pnpm engine:lint
```
