import io
import json

import polars as pl
import pytest
from fastapi.testclient import TestClient

from data_service_processor import app as app_module
from data_service_processor.models import Manifest
from data_service_processor.processor import SCHEMAS, process


def entry(close=10, day="2024-01-01"):
    return {
        "date": day,
        "open": 10,
        "close": close,
        "high": 12,
        "low": 9,
        "adjusted_close": close,
        "volume": 100,
    }


def manifest_json(**raw_overrides):
    return {
        "jobId": "job-1",
        "dataset": "prices_eod",
        "symbol": "AAPL.US",
        "outputKey": "dataset=prices_eod/symbol=AAPL.US/data.parquet",
        "input": {
            "runId": "run-1",
            "provider": "eodhd",
            "requestedRange": {"from": "2024-01-01", "to": "2024-01-31"},
            "key": "raw-1",
            "etag": "raw-etag",
            "rowCount": 2,
            **raw_overrides,
        },
    }


class Storage:
    def __init__(self, entries=None):
        self.envelope = {
            "version": 1,
            "runId": "run-1",
            "dataset": "prices_eod",
            "provider": "eodhd",
            "symbol": "AAPL.US",
            "requestedRange": {"from": "2024-01-01", "to": "2024-01-31"},
            "entries": entries or [entry(12, "2024-01-02"), entry(10)],
        }
        self.reads = []
        self.writes = []

    def get_object(self, **kwargs):
        self.reads.append(kwargs)
        return {
            "ETag": '"raw-etag"',
            "Body": io.BytesIO(json.dumps(self.envelope).encode()),
        }

    def put_object(self, **kwargs):
        self.writes.append(kwargs)
        return {"ETag": '"output-etag"'}


def test_rebuilds_sorted_parquet_from_the_named_raw_object():
    storage = Storage()
    etag = process(storage, Manifest.model_validate(manifest_json()))

    assert etag == "output-etag"
    assert storage.reads == [
        {"Bucket": "raw-market-data", "Key": "raw-1", "IfMatch": '"raw-etag"'}
    ]
    output = storage.writes[0]
    assert output["Bucket"] == "processed-market-data"
    assert output["Key"] == "dataset=prices_eod/symbol=AAPL.US/data.parquet"
    frame = pl.read_parquet(io.BytesIO(output["Body"]))
    assert dict(frame.schema) == SCHEMAS["prices_eod"]
    assert frame["close"].to_list() == [10, 12]


def test_later_rows_win_on_duplicate_dates():
    storage = Storage([entry(10), entry(11)])
    process(storage, Manifest.model_validate(manifest_json()))
    frame = pl.read_parquet(io.BytesIO(storage.writes[0]["Body"]))
    assert frame["close"].to_list() == [11]


@pytest.mark.parametrize(
    "change",
    [
        lambda m, s: s.envelope.update(symbol="MSFT.US"),
        lambda m, s: s.envelope.update(runId="other"),
        lambda m, s: m["input"].update(rowCount=3),
        lambda m, s: s.envelope["entries"].append(entry(1, "2025-01-01")),
        lambda m, s: s.envelope["entries"][0].update(volume=-1),
    ],
)
def test_mismatched_or_invalid_raw_data_is_never_written(change):
    manifest, storage = manifest_json(), Storage()
    change(manifest, storage)
    with pytest.raises(ValueError):
        process(storage, Manifest.model_validate(manifest))
    assert storage.writes == []


def test_http_endpoint_returns_etag_or_error_detail(monkeypatch):
    storage = Storage()

    class FakeClient:
        def __enter__(self):
            return storage

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(app_module, "s3_client", FakeClient)
    with TestClient(app_module.app) as client:
        assert client.get("/health").status_code == 200

        ok = client.post("/jobs", json=manifest_json())
        assert ok.status_code == 200
        assert ok.json() == {"outputEtag": "output-etag"}

        storage.envelope["symbol"] = "MSFT.US"
        failed = client.post("/jobs", json=manifest_json())
        assert failed.status_code == 500
        assert failed.json()["detail"] == (
            "ValueError: Raw envelope differs from the manifest"
        )

        assert client.post("/jobs", json={"jobId": "x"}).status_code == 422
