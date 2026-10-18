import io

import polars as pl

from .models import Envelope, Manifest

# Parquet schema per dataset. Add an entry (and an entry model) for new datasets.
SCHEMAS = {
    "prices_eod": {
        "date": pl.Date,
        "open": pl.Float64,
        "close": pl.Float64,
        "high": pl.Float64,
        "low": pl.Float64,
        "adjusted_close": pl.Float64,
        "volume": pl.Int64,
    },
}


def _quoted(etag):
    return '"' + etag.strip('"') + '"'


def read_envelope(s3, manifest: Manifest, raw_bucket: str) -> Envelope:
    """Read exactly the raw object version named in the manifest."""
    raw = manifest.input
    result = s3.get_object(Bucket=raw_bucket, Key=raw.key, IfMatch=_quoted(raw.etag))
    body = result["Body"]
    try:
        envelope = Envelope.model_validate_json(body.read())
    finally:
        body.close()

    if (
        envelope.run_id != raw.run_id
        or envelope.dataset != manifest.dataset
        or envelope.symbol != manifest.symbol
        or envelope.provider != raw.provider
        or envelope.requested_range != raw.requested_range
        or len(envelope.entries) != raw.row_count
    ):
        raise ValueError("Raw envelope differs from the manifest")
    if any(
        not raw.requested_range.start <= row.date <= raw.requested_range.end
        for row in envelope.entries
    ):
        raise ValueError("Raw entry lies outside the requested range")
    return envelope


def build_frame(manifest: Manifest, envelope: Envelope) -> pl.DataFrame:
    """Rebuild the full dataset from one snapshot; later rows win on duplicate dates."""
    return (
        pl.DataFrame(
            [row.model_dump() for row in envelope.entries],
            schema=SCHEMAS[manifest.dataset],
        )
        .unique(subset=["date"], keep="last", maintain_order=True)
        .sort("date")
    )


def process(s3, manifest: Manifest, *, raw_bucket: str, processed_bucket: str) -> str:
    """Rebuild the canonical Parquet object and return its ETag."""
    frame = build_frame(manifest, read_envelope(s3, manifest, raw_bucket))
    output = io.BytesIO()
    frame.write_parquet(output)
    result = s3.put_object(
        Bucket=processed_bucket,
        Key=manifest.output_key,
        Body=output.getvalue(),
        ContentType="application/vnd.apache.parquet",
    )
    return result["ETag"].strip('"')
