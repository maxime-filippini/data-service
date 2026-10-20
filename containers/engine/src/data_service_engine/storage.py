"""Reads canonical datasets from and writes calculation results to R2."""

import io
import re
from datetime import date

import polars as pl
from botocore.exceptions import ClientError

from .framework import MissingDataError

PARQUET = "application/vnd.apache.parquet"
_DATASET = re.compile(r"[a-z0-9_]+")


def _is_missing(error: ClientError) -> bool:
    return error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}


def _read_parquet(s3, bucket: str, key: str) -> tuple[pl.DataFrame, str] | None:
    try:
        result = s3.get_object(Bucket=bucket, Key=key)
    except ClientError as error:
        if _is_missing(error):
            return None
        raise
    body = result["Body"]
    try:
        frame = pl.read_parquet(io.BytesIO(body.read()))
    finally:
        body.close()
    return frame, result["ETag"].strip('"')


class SymbolReader:
    """Loads `(dataset, symbol)` Parquet objects, each at most once.

    One reader serves one request, so portfolios sharing a symbol read it once.
    """

    def __init__(self, s3, bucket: str):
        self._s3 = s3
        self._bucket = bucket
        self._cache: dict[tuple[str, str], pl.DataFrame] = {}

    def __call__(self, dataset: str, symbol: str) -> pl.DataFrame:
        if not _DATASET.fullmatch(dataset):
            raise ValueError(f"Invalid dataset name {dataset!r}")
        if not symbol or "/" in symbol:
            raise ValueError(f"Invalid symbol {symbol!r}")
        if (dataset, symbol) not in self._cache:
            key = f"dataset={dataset}/symbol={symbol}/data.parquet"
            found = _read_parquet(self._s3, self._bucket, key)
            if found is None:
                raise MissingDataError(f"No {dataset} data for {symbol}")
            self._cache[dataset, symbol] = found[0]
        return self._cache[dataset, symbol]


def write_results(s3, bucket: str, key: str, as_of: date, rows: pl.DataFrame) -> str:
    """Replace the as-of date's rows in the calculation's Parquet object.

    Rows for other dates are kept. The write is conditional on the object not
    having changed since it was read. Returns the new ETag.
    """
    found = _read_parquet(s3, bucket, key)
    if found is None:
        merged = rows
        condition = {"IfNoneMatch": "*"}
    else:
        existing, etag = found
        kept = existing.filter(pl.col("as_of") != as_of)
        # Relaxed so a type can gain columns; old rows get nulls for them.
        merged = pl.concat([kept, rows], how="diagonal_relaxed")
        condition = {"IfMatch": f'"{etag}"'}

    leading = [name for name in rows.columns if name in merged.columns]
    trailing = [name for name in merged.columns if name not in leading]
    merged = merged.select(*leading, *trailing).sort(
        "as_of", "portfolio_id", nulls_last=True, maintain_order=True
    )

    output = io.BytesIO()
    merged.write_parquet(output)
    result = s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=output.getvalue(),
        ContentType=PARQUET,
        **condition,
    )
    return result["ETag"].strip('"')
