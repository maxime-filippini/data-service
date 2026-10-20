import io
from datetime import date, timedelta

import polars as pl
import pytest
from botocore.exceptions import ClientError

BUCKET = "processed-market-data-dev"

ENVIRONMENT = {
    "R2_ENDPOINT_URL": "https://account.r2.cloudflarestorage.com",
    "R2_ACCESS_KEY_ID": "access-key",
    "R2_SECRET_ACCESS_KEY": "secret-key",
    "PROCESSED_BUCKET": BUCKET,
}


class FakeR2:
    """In-memory S3 with ETags and conditional puts, like R2."""

    def __init__(self):
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.reads: list[str] = []
        self.writes: list[dict] = []
        self._version = 0

    def put(self, key: str, body: bytes, bucket: str = BUCKET) -> str:
        self._version += 1
        etag = f"etag-{self._version}"
        self.objects[bucket, key] = (body, etag)
        return etag

    def put_df(self, key: str, df: pl.DataFrame) -> str:
        output = io.BytesIO()
        df.write_parquet(output)
        return self.put(key, output.getvalue())

    def read_df(self, key: str) -> pl.DataFrame:
        return pl.read_parquet(io.BytesIO(self.objects[BUCKET, key][0]))

    def get_object(self, Bucket, Key):
        self.reads.append(Key)
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        body, etag = self.objects[Bucket, Key]
        return {"Body": io.BytesIO(body), "ETag": f'"{etag}"'}

    def put_object(
        self, Bucket, Key, Body, ContentType, IfMatch=None, IfNoneMatch=None
    ):
        self.writes.append({"Key": Key, "IfMatch": IfMatch, "IfNoneMatch": IfNoneMatch})
        current = self.objects.get((Bucket, Key))
        if (IfNoneMatch == "*" and current is not None) or (
            IfMatch is not None and (current is None or f'"{current[1]}"' != IfMatch)
        ):
            raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
        return {"ETag": f'"{self.put(Key, Body, Bucket)}"'}


def weekdays(end: date, count: int) -> list[date]:
    days, day = [], end
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day)
        day -= timedelta(days=1)
    return days[::-1]


def prices_df(closes: list[float], end: date = date(2026, 10, 16)) -> pl.DataFrame:
    """A prices_eod dataframe with one weekday row per close, ending on `end`."""
    return pl.DataFrame(
        {
            "date": weekdays(end, len(closes)),
            "open": closes,
            "close": closes,
            "high": closes,
            "low": closes,
            "adjusted_close": closes,
            "volume": [100] * len(closes),
        },
        schema_overrides={"date": pl.Date, "volume": pl.Int64},
    )


def prices_key(symbol: str) -> str:
    return f"dataset=prices_eod/symbol={symbol}/data.parquet"


@pytest.fixture
def r2():
    return FakeR2()


@pytest.fixture
def environment(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    for name, value in ENVIRONMENT.items():
        monkeypatch.setenv(name, value)


@pytest.fixture
def engine_r2(environment, monkeypatch, r2):
    """Points the runtime at the fake R2 with settings from the environment."""
    from data_service_engine import runtime

    class FakeClient:
        def __init__(self, settings):
            self.settings = settings

        def __enter__(self):
            return r2

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(runtime, "s3_client", FakeClient)
    return r2
