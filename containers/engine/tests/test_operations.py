import io
import json
from contextlib import contextmanager
from datetime import date
from pathlib import Path

import polars as pl
import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from fastapi.testclient import TestClient
from pydantic import ValidationError

from data_service_engine.app import app
from data_service_engine.operations.artifacts import (
    FileArtifactStore,
    S3ArtifactStore,
)
from data_service_engine.operations.errors import TerminalError
from data_service_engine.operations.registry import dispatch
from data_service_engine.operations.schemas import export_json
from data_service_engine.settings import OperationSettings

from .conftest import FakeR2

RUN_ID = "0b6c1f9e-5a2d-4c3b-9e8f-1a2b3c4d5e6f"
RAW_ID = f"runs/{RUN_ID}/download/raw.json"
PRICES_ID = f"runs/{RUN_ID}/normalize/prices.parquet"
REPO = Path(__file__).resolve().parents[3]


def entry(day: str, close: float, volume: int = 100) -> dict:
    return {
        "date": day,
        "open": close,
        "close": close,
        "high": close,
        "low": close,
        "adjusted_close": close,
        "volume": volume,
    }


def envelope(entries: list[dict], **overrides) -> dict:
    return {
        "version": 1,
        "runId": RUN_ID,
        "dataset": "prices_eod",
        "provider": "eodhd",
        "symbol": "AAPL.US",
        "requestedRange": {"from": "2024-01-01", "to": "2024-01-10"},
        "receivedAt": "2024-01-10T02:00:00.000Z",
        "entries": entries,
        **overrides,
    }


def request(**overrides) -> dict:
    return {
        "execution": {"runId": RUN_ID, "stepId": "normalize"},
        "inputs": {
            "raw": {"id": RAW_ID, "format": "json", "schema": "raw-prices-eod/v1"}
        },
        "params": {},
        **overrides,
    }


@pytest.fixture
def root(tmp_path, monkeypatch):
    """Operations read and write files under ARTIFACT_ROOT, as locally."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path / "r2"))
    return tmp_path / "r2"


@pytest.fixture
def client(root):
    with TestClient(app) as client:
        yield client


def write_raw(root: Path, body: dict | str) -> None:
    path = root / RAW_ID
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body if isinstance(body, str) else json.dumps(body))


def test_normalize_writes_sorted_deduplicated_parquet_under_the_step(client, root):
    write_raw(
        root,
        envelope(
            [
                entry("2024-01-03", 102.5),
                entry("2024-01-02", 101.0),
                entry("2024-01-03", 103.0, volume=250),
            ]
        ),
    )

    response = client.post("/operations/normalize-prices-eod", json=request())

    assert response.status_code == 200, response.text
    assert response.json() == {
        "prices": {"id": PRICES_ID, "format": "parquet", "schema": "prices-eod/v1"}
    }
    df = pl.read_parquet(root / PRICES_ID)
    assert df.schema == pl.Schema(
        {
            "date": pl.Date,
            "open": pl.Float64,
            "close": pl.Float64,
            "high": pl.Float64,
            "low": pl.Float64,
            "adjusted_close": pl.Float64,
            "volume": pl.Int64,
        }
    )
    assert df.select("date", "close", "volume").rows() == [
        (date(2024, 1, 2), 101.0, 100),
        (date(2024, 1, 3), 103.0, 250),
    ]


def test_repeating_a_call_after_a_lost_response_replaces_the_same_artifact(
    client, root
):
    write_raw(root, envelope([entry("2024-01-02", 101.0)]))

    first = client.post("/operations/normalize-prices-eod", json=request())
    written = (root / PRICES_ID).read_bytes()
    second = client.post("/operations/normalize-prices-eod", json=request())

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert (root / PRICES_ID).read_bytes() == written
    assert sorted(p.name for p in (root / PRICES_ID).parent.iterdir()) == [
        "prices.parquet"
    ]


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        (None, "does not exist"),
        ("not json", "not a valid raw-prices-eod/v1 envelope"),
        (envelope([entry("2024-01-02", 1.0)], runId="other"), "another run"),
        (envelope([entry("2024-02-01", 1.0)]), "outside the requested range"),
        (envelope([entry("2024-01-02", 1.0, volume=-1)]), "not a valid"),
    ],
)
def test_invalid_or_missing_input_is_a_terminal_failure(client, root, raw, message):
    if raw is not None:
        write_raw(root, raw)

    response = client.post("/operations/normalize-prices-eod", json=request())

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["kind"] == "terminal"
    assert message in error["message"]
    assert not (root / PRICES_ID).exists()


def test_invalid_requests_are_terminal_with_issues(client):
    response = client.post(
        "/operations/normalize-prices-eod",
        json=request(
            inputs={"raw": {"id": "../etc/passwd", "format": "json", "schema": "x"}},
            extra=1,
        ),
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["kind"] == "terminal"
    paths = {tuple(issue["path"]) for issue in error["issues"]}
    assert ("inputs", "raw", "id") in paths
    assert ("inputs", "raw", "schema") in paths
    assert ("extra",) in paths


def test_unknown_operations_are_terminal_not_found(client):
    response = client.post("/operations/nope", json=request())
    assert response.status_code == 404
    assert response.json()["error"]["kind"] == "terminal"


def test_operations_are_described_with_their_schemas(client):
    [normalize] = client.get("/operations").json()
    assert normalize["name"] == "normalize-prices-eod"
    assert normalize["request"]["required"] == ["execution", "inputs", "params"]
    assert normalize["response"]["required"] == ["prices"]


class BrokenS3:
    def __init__(self, error):
        self.error = error

    def get_object(self, **_):
        raise self.error

    def put_object(self, **_):
        raise self.error


@pytest.mark.parametrize(
    "error",
    [
        ClientError({"Error": {"Code": "InternalError"}}, "GetObject"),
        EndpointConnectionError(endpoint_url="https://r2.example"),
    ],
)
def test_storage_failures_are_transient(error):
    @contextmanager
    def store():
        yield S3ArtifactStore(BrokenS3(error), "raw-market-data")

    outcome = dispatch("normalize-prices-eod", json.dumps(request()).encode(), store)

    assert outcome.status == 503
    assert outcome.body["error"]["kind"] == "transient"


def test_unexpected_errors_are_reported_as_transient_not_as_success(root):
    @contextmanager
    def store():
        raise RuntimeError("boom")
        yield

    outcome = dispatch("normalize-prices-eod", json.dumps(request()).encode(), store)

    assert outcome.status == 500
    assert outcome.body == {
        "error": {"kind": "transient", "message": "RuntimeError: boom", "issues": []}
    }


def test_s3_store_reads_and_writes_only_run_artifacts():
    r2 = FakeR2()
    store = S3ArtifactStore(r2, "raw-market-data")
    assert store.read(RAW_ID) is None
    store.write(PRICES_ID, b"data", "application/vnd.apache.parquet")
    assert store.read(PRICES_ID) == b"data"
    assert ("raw-market-data", PRICES_ID) in r2.objects
    for key in ["dataset=prices_eod/symbol=A.US/data.parquet", f"{RAW_ID}/../x.json"]:
        with pytest.raises(TerminalError):
            store.read(key)


def test_file_store_never_leaves_the_root(tmp_path):
    store = FileArtifactStore(tmp_path)
    with pytest.raises(TerminalError):
        store.write("runs/../../escape.json", b"x", "application/json")
    store.write(RAW_ID, b"{}", "application/json")
    assert store.read(RAW_ID) == b"{}"


def test_settings_need_a_local_root_or_r2(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    for name in ["ARTIFACT_ROOT", "ARTIFACT_BUCKET", "R2_ENDPOINT_URL"]:
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValidationError, match="ARTIFACT_BUCKET"):
        OperationSettings()
    monkeypatch.setenv("ARTIFACT_ROOT", str(tmp_path))
    assert OperationSettings().artifact_root == tmp_path


def test_exported_schemas_match_the_committed_contracts():
    """The Worker's generated contracts come from this file; regenerate with
    `pnpm operations:generate` when it is stale."""
    committed = REPO / "src" / "operations" / "schemas.json"
    assert export_json() == committed.read_text()


def test_an_empty_download_normalizes_to_an_empty_table(client, root):
    write_raw(root, envelope([]))
    response = client.post("/operations/normalize-prices-eod", json=request())
    assert response.status_code == 200
    df = pl.read_parquet(io.BytesIO((root / PRICES_ID).read_bytes()))
    assert df.height == 0
    assert df.columns[0] == "date"
