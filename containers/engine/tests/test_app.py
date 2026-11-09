import io
from datetime import date

import polars as pl
import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from data_service_engine.app import ARROW_STREAM, app
from data_service_engine.framework import CalculationResult, CalculationType, registry
from data_service_engine.market_data import market_data

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
    types = {item["name"]: item for item in client.get("/types").json()}
    assert "hypothetical_portfolio_returns" in types
    vol = types["ex_ante_vol"]
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


@pytest.mark.parametrize(
    "type_name, params, row_count",
    [
        ("ex_ante_vol", {"window": 3}, 1),
        ("hypothetical_portfolio_returns", {}, 4),
    ],
)
def test_run_writes_results_and_reports_each_portfolio(
    client, engine_r2, type_name, params, row_count
):
    response = client.post(
        "/runs",
        json=run_request(
            type=type_name,
            params=params,
            portfolios=[portfolio("p1"), portfolio("p2", "MISSING.US")],
        ),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "partial"
    assert body["rowCount"] == row_count
    assert (
        body["outputEtag"]
        == engine_r2.objects["processed-market-data-dev", OUTPUT_KEY][1]
    )
    assert body["portfolios"] == [
        {
            "portfolioId": "p1",
            "status": "completed",
            "rowCount": row_count,
            "error": None,
        },
        {
            "portfolioId": "p2",
            "status": "failed",
            "rowCount": 0,
            "error": "No prices_eod data for MISSING.US",
        },
    ]
    df = engine_r2.read_df(OUTPUT_KEY)
    assert (
        df.select("as_of", "portfolio_id").rows()
        == [(date(2026, 10, 16), "p1")] * row_count
    )


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


def test_return_history_batch_mixes_saved_and_inline_and_reads_each_symbol_once(
    client, engine_r2
):
    saved = portfolio("p1", "A.US", "2026-10-15")
    saved["snapshots"].append(
        {
            "holdingsDate": "2026-10-17",
            "holdings": [{"symbol": "MISSING.US", "weight": 1}],
        }
    )
    batch = {
        "type": "hypothetical_portfolio_returns",
        "params": {},
        "asOf": AS_OF,
        "portfolios": [saved, {"holdings": [{"symbol": "A.US", "weight": -2}]}, saved],
    }
    response = client.post("/calculate", json=batch)
    assert response.status_code == 200, response.text
    rows = response.json()["rows"]
    assert len(rows) == 12
    groups = [
        [row for row in rows if row["portfolio_index"] == index] for index in range(3)
    ]
    assert [group[0]["portfolio_id"] for group in groups] == ["p1", None, "p1"]
    assert groups[0][0]["date"] < "2026-10-15", (
        "use the as-of holdings even before their date"
    )
    assert [row["return"] for row in groups[1]] == pytest.approx(
        [-2 * row["return"] for row in groups[0]]
    )
    assert [row["return"] for row in groups[2]] == [row["return"] for row in groups[0]]
    assert engine_r2.reads.count(prices_key("A.US")) == 1
    assert engine_r2.writes == []

    arrow = client.post("/calculate", json=batch, headers={"accept": ARROW_STREAM})
    assert arrow.status_code == 200
    frame = pl.read_ipc_stream(io.BytesIO(arrow.content))
    assert frame["portfolio_index"].to_list() == [
        row["portfolio_index"] for row in rows
    ]
    assert frame["return"].to_list() == [row["return"] for row in rows]
    assert engine_r2.writes == []


@pytest.mark.parametrize(
    "type_name, params",
    [
        ("ex_ante_vol", {"window": 3}),
        ("hypothetical_portfolio_returns", {}),
    ],
)
def test_batch_errors_identify_the_entry_and_never_return_partial_rows(
    client, engine_r2, type_name, params
):
    request = {
        "type": type_name,
        "params": params,
        "asOf": AS_OF,
        "portfolios": [
            portfolio("ok"),
            {"holdings": [{"symbol": "MISSING.US", "weight": 1}]},
        ],
    }
    response = client.post("/calculate", json=request)
    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "portfolioIndex": 1,
            "portfolioId": None,
            "error": "No prices_eod data for MISSING.US",
        }
    }
    assert engine_r2.writes == []

    request["portfolios"][1] = portfolio("too-new", holdings_date="2026-10-17")
    response = client.post("/calculate", json=request)
    assert response.status_code == 422
    assert response.json()["detail"]["portfolioIndex"] == 1
    assert response.json()["detail"]["portfolioId"] == "too-new"


def test_unexpected_batch_infrastructure_failures_remain_server_errors(
    client, engine_r2, monkeypatch
):
    def broken(**kwargs):
        raise RuntimeError("storage unavailable")

    monkeypatch.setattr(engine_r2, "get_object", broken)
    response = client.post(
        "/calculate",
        json={
            "type": "hypothetical_portfolio_returns",
            "params": {},
            "asOf": AS_OF,
            "portfolios": [portfolio("p1")],
        },
    )
    assert response.status_code == 500
    assert response.json()["detail"]["portfolioIndex"] == 0
    assert engine_r2.writes == []


@pytest.mark.parametrize(
    "patch",
    [
        {"portfolios": []},
        {"portfolios": [portfolio("p1")] * 101},
        {"portfolio": portfolio("p1"), "portfolios": [portfolio("p1")]},
    ],
)
def test_batch_shape_is_validated(client, patch):
    response = client.post(
        "/calculate",
        json={
            "type": "hypothetical_portfolio_returns",
            "params": {},
            "asOf": AS_OF,
            **patch,
        },
    )
    assert response.status_code == 422


def test_symbol_type_controls_its_reads_and_persists_without_portfolio_columns(
    client, engine_r2, monkeypatch
):
    class SymbolParams(BaseModel):
        symbols: list[str]

    calls = []

    def symbol_prices(params, ctx):
        calls.append(ctx)
        with market_data(ctx.as_of, ctx.load_symbol) as data:
            rows = (
                data.load("prices_eod", params.symbols)
                .group_by("symbol")
                .agg(pl.col("date").max().alias("last_price_date"))
                .sort("symbol")
            )
        return CalculationResult(rows)

    monkeypatch.setitem(
        registry(),
        "symbol_prices",
        CalculationType(
            name="symbol_prices",
            description="",
            params=SymbolParams,
            output={"last_price_date": pl.Date},
            run=symbol_prices,
        ),
    )
    engine_r2.put_df(prices_key("B.US"), prices_df([4, 5, 6], end=date(2026, 10, 19)))
    request = {
        "type": "symbol_prices",
        "params": {"symbols": ["A.US", "B.US"]},
        "asOf": AS_OF,
    }
    response = client.post("/calculate", json=request)
    assert response.status_code == 200, response.text
    assert response.json()["rows"] == [
        {"as_of": AS_OF, "symbol": "A.US", "last_price_date": AS_OF},
        {"as_of": AS_OF, "symbol": "B.US", "last_price_date": AS_OF},
    ]
    assert len(calls) == 1
    assert engine_r2.writes == []

    saved = client.post(
        "/runs", json={**request, "runId": "symbol-run", "outputKey": OUTPUT_KEY}
    )
    assert saved.status_code == 200
    assert saved.json()["status"] == "completed"
    assert saved.json()["portfolios"] == []
    assert saved.json()["rowCount"] == 2
    assert len(calls) == 2
    assert engine_r2.read_df(OUTPUT_KEY).columns == [
        "as_of",
        "symbol",
        "last_price_date",
    ]

    # The generic history writer also replaces/merges this schema on later runs.
    earlier = client.post(
        "/runs",
        json={
            **request,
            "asOf": "2026-10-15",
            "runId": "earlier",
            "outputKey": OUTPUT_KEY,
        },
    )
    assert earlier.json()["status"] == "completed"
    assert (
        engine_r2.read_df(OUTPUT_KEY)["as_of"].to_list()
        == [date(2026, 10, 15)] * 2 + [date(2026, 10, 16)] * 2
    )
