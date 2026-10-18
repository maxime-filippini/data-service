# Market data processor

Python half of [data-service](https://github.com/maxime-filippini/data-service).
It turns one raw provider download into the canonical Parquet object for a
symbol. The Worker owns all job state in D1; this service only reads R2,
writes R2 and returns the result.

## Contract

The Worker's queue consumer calls `POST /jobs` with a manifest:

```json
{
  "jobId": "…",
  "dataset": "prices_eod",
  "symbol": "AAPL.US",
  "outputKey": "dataset=prices_eod/symbol=AAPL.US/data.parquet",
  "input": {
    "runId": "…",
    "provider": "eodhd",
    "requestedRange": { "from": "2016-01-01", "to": "2026-10-05" },
    "key": "dataset=prices_eod/symbol=AAPL.US/run=….json",
    "etag": "…",
    "rowCount": 2700
  }
}
```

- `200 {"outputEtag": "…"}`: the Parquet object was written.
- `500 {"detail": "…"}`: processing failed; the Worker records the detail on the job.
- `422`: the manifest itself was invalid.

The container is reachable only through the Worker, so the endpoint has no
authentication. `GET /health` is a liveness probe.

Every job is a full rebuild from one full-history snapshot, so running the
same manifest twice is safe.

## Processing

The processor reads exactly the raw object version in the manifest (`IfMatch`
on its ETag). It checks that the envelope matches the manifest (run, dataset,
symbol, provider, range, row count) and that every row is valid. Then it writes
a date-sorted Parquet file. If a date appears twice, the later row wins.

`prices_eod` columns: `date` (Date), `open`, `close`, `high`, `low`,
`adjusted_close` (Float64), `volume` (Int64).

To add a dataset, add its entry model and envelope literal in `models.py` and
its Parquet schema in `processor.py`.

## Configuration

Set these variables in the environment or a local `.env` file:

| Variable | Purpose |
| --- | --- |
| `R2_ENDPOINT_URL` | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | R2 S3 access key |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret key |

The credentials need read access to `raw-market-data` and write access to
`processed-market-data`.

## Run locally

```sh
uv sync
uv run processor manifest.json          # one manifest, prints {"outputEtag": …}
uv run uvicorn data_service_processor.app:app --port 8080
```

The data-service Worker builds the container from this directory
(`../data-service-processor` relative to the Worker repo). Cloudflare requires
a `linux/amd64` image:

```sh
docker build --platform linux/amd64 -t market-data-processor .
```

## Verification

```sh
uv run pytest
uv run ruff check src tests
uv run ruff format --check src tests
```

On CPUs without AVX2, Polars needs its compatibility runtime:
`uv run --with polars-runtime-compat pytest`.
