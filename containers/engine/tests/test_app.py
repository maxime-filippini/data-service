import io
from datetime import date

import polars as pl
import pytest
from fastapi.testclient import TestClient

from data_service_engine.app import ARROW_STREAM, app

from .conftest import prices_df, prices_key

AS_OF = "2026-10-16"
OUTPUT_KEY = "calculation=calc-1/data.parquet"


def portfolio(id, symbol="A.US", holdings_date="2026-01-02"):
    return {
        "id": id,
        "name": id,
        "snapshots": [
            {
                "holdingsDate": holdings_date,
                "holdings": [{"symbol": symbol, "weight": 1}],
            }
        ],
    }


def run_request(**overrides):
    return {
        "runId": "run-1",
        "type": "ex_ante_vol",
        "params": {"window": 3},
        "asOf": AS_OF,
        "portfolios": [portfolio("p1")],
        "outputKey": OUTPUT_KEY,
        **overrides,
    }


@pytest.fixture
def client(engine_r2):
    engine_r2.put_df(prices_key("A.US"), prices_df([100, 101, 99, 102, 103]))
    with TestClient(app) as client:
        yield client


def test_health_and_types(client):
    assert client.get("/health").json() == {"status": "ok"}
    [vol] = client.get("/types").json()
    assert vol["name"] == "ex_ante_vol"
    assert vol["takesPortfolio"] is True
    assert vol["paramsSchema"]["properties"]["window"]["default"] == 252
    assert vol["output"]["volatility"] == "Float64"


def test_validate_fills_defaults_or_lists_errors(client):
    ok = client.post("/types/ex_ante_vol/validate", json={"params": {"window": 20}})
    assert ok.status_code == 200
    assert ok.json()["params"] == {
        "window": 20,
        "annualisation": 252,
        "decay": None,
        "normalise_weights": False,
    }

    bad = client.post("/types/ex_ante_vol/validate", json={"params": {"window": 1}})
    assert bad.status_code == 422
    assert bad.json()["detail"][0]["loc"] == ["window"]

    assert client.post("/types/nope/validate", json={"params": {}}).status_code == 404


def test_run_writes_results_and_reports_each_portfolio(client, engine_r2):
    response = client.post(
        "/runs",
        json=run_request(portfolios=[portfolio("p1"), portfolio("p2", "MISSING.US")]),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "partial"
    assert body["rowCount"] == 1
    assert (
        body["outputEtag"]
        == engine_r2.objects["processed-market-data-dev", OUTPUT_KEY][1]
    )
    assert body["portfolios"] == [
        {"portfolioId": "p1", "status": "completed", "rowCount": 1, "error": None},
        {
            "portfolioId": "p2",
            "status": "failed",
            "rowCount": 0,
            "error": "No prices_eod data for MISSING.US",
        },
    ]
    df = engine_r2.read_df(OUTPUT_KEY)
    assert df.select("as_of", "portfolio_id").rows() == [(date(2026, 10, 16), "p1")]


@pytest.mark.parametrize(
    "overrides, error",
    [
        ({"type": "removed_type"}, "Unknown calculation type 'removed_type'"),
        ({"params": {"window": 1}}, "Invalid Params: window:"),
        ({"portfolios": []}, "ex_ante_vol needs at least one portfolio"),
        (
            {"portfolios": [portfolio("p1", holdings_date="2026-10-17")]},
            "No holdings on or before 2026-10-16",
        ),
        ({"portfolios": [portfolio("p1", "MISSING.US")]}, "No prices_eod data"),
        (
            {"portfolios": [portfolio("p1", "X.US"), portfolio("p2", "Y.US")]},
            "All 2 portfolios failed",
        ),
    ],
)
def test_failed_runs_write_nothing(client, engine_r2, overrides, error):
    body = client.post("/runs", json=run_request(**overrides)).json()
    assert body["status"] == "failed"
    assert body["error"].startswith(error)
    assert body["outputEtag"] is None
    assert engine_r2.writes == []


def test_run_without_configuration_fails_instead_of_using_defaults(client, monkeypatch):
    monkeypatch.delenv("PROCESSED_BUCKET")
    body = client.post("/runs", json=run_request()).json()
    assert body["status"] == "failed"
    assert body["error"].startswith("Invalid EngineSettings: processed_bucket")


def test_malformed_run_requests_are_rejected(client):
    assert client.post("/runs", json={"runId": "x"}).status_code == 422
    unsaved = run_request(portfolios=[{"holdings": [{"symbol": "A", "weight": 1}]}])
    assert client.post("/runs", json=unsaved).status_code == 422
    undated = run_request(
        portfolios=[{"id": "p", "holdings": [{"symbol": "A", "weight": 1}]}]
    )
    assert client.post("/runs", json=undated).status_code == 422
    zero = portfolio("p")
    zero["snapshots"][0]["holdings"][0]["weight"] = 0
    assert client.post("/runs", json=run_request(portfolios=[zero])).status_code == 422


def calculate_request(**overrides):
    return {
        "type": "ex_ante_vol",
        "params": {"window": 3},
        "asOf": AS_OF,
        "portfolio": {"holdings": [{"symbol": "A.US", "weight": 1}]},
        **overrides,
    }


def test_calculate_returns_rows_as_json_or_arrow(client, engine_r2):
    response = client.post("/calculate", json=calculate_request())
    assert response.status_code == 200
    [row] = response.json()["rows"]
    assert row["as_of"] == AS_OF
    assert row["portfolio_id"] is None
    assert row["observations"] == 3

    arrow = client.post(
        "/calculate", json=calculate_request(), headers={"accept": ARROW_STREAM}
    )
    assert arrow.headers["content-type"] == ARROW_STREAM
    df = pl.read_ipc_stream(io.BytesIO(arrow.content))
    assert df["volatility"].to_list() == [row["volatility"]]
    assert engine_r2.writes == []


def test_calculate_errors(client):
    assert (
        client.post("/calculate", json=calculate_request(type="x")).status_code == 404
    )
    bad_params = client.post("/calculate", json=calculate_request(params={"window": 1}))
    assert bad_params.status_code == 422
    no_portfolio = client.post("/calculate", json=calculate_request(portfolio=None))
    assert no_portfolio.status_code == 422
    assert no_portfolio.json()["detail"] == "ex_ante_vol needs at least one portfolio"

    failed = client.post(
        "/calculate",
        json=calculate_request(portfolio=portfolio("p1", "MISSING.US")),
    )
    assert failed.status_code == 500
    assert failed.json()["detail"] == "No prices_eod data for MISSING.US"
