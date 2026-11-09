from datetime import date

import polars as pl
import pytest

from data_service_engine.framework import get_type
from data_service_engine.models import Portfolio
from data_service_engine.storage import SymbolReader

from .conftest import BUCKET, prices_df, prices_key

AS_OF = date(2026, 10, 16)
RETURNS = get_type("hypothetical_portfolio_returns")


@pytest.fixture
def reader(r2):
    r2.put_df(
        prices_key("A.US"),
        prices_df([100.0, 110.0, 99.0, 108.9, 9999.0], end=date(2026, 10, 19)),
    )
    r2.put_df(
        prices_key("B.US"),
        prices_df([200.0, 200.0, 220.0, 198.0, 1.0], end=date(2026, 10, 19)),
    )
    return SymbolReader(r2, BUCKET)


def calculate(reader, portfolio, params=None):
    rows, outcomes = RETURNS.calculate(params or {}, AS_OF, [portfolio], reader)
    assert outcomes[0].error is None, outcomes[0].error
    return rows


def test_selects_as_of_holdings_and_applies_them_even_before_the_snapshot(reader):
    portfolio = Portfolio.model_validate(
        {
            "id": "saved",
            "snapshots": [
                {
                    "holdingsDate": "2020-01-01",
                    "holdings": [{"symbol": "A.US", "weight": 1}],
                },
                {
                    "holdingsDate": "2026-10-15",
                    "holdings": [{"symbol": "B.US", "weight": 2}],
                },
                {
                    "holdingsDate": "2026-10-17",
                    "holdings": [{"symbol": "A.US", "weight": 100}],
                },
            ],
        }
    )
    rows = calculate(reader, portfolio)
    assert rows["date"].to_list() == [date(2026, 10, d) for d in [14, 15, 16]]
    assert rows["return"].to_list() == pytest.approx([0, 0.2, -0.2])
    assert rows["holdings_date"].to_list() == [date(2026, 10, 15)] * 3
    assert rows["as_of"].to_list() == [AS_OF] * 3
    assert rows["portfolio_id"].to_list() == ["saved"] * 3


def test_inline_short_weights_are_not_normalised_and_first_return_has_a_baseline(
    reader,
):
    portfolio = Portfolio(
        holdings=[{"symbol": "A.US", "weight": 0.6}, {"symbol": "B.US", "weight": -0.4}]
    )
    rows = calculate(reader, portfolio, {"start_date": "2026-10-15"})
    assert rows["return"].to_list() == pytest.approx([-0.1, 0.1])
    assert rows["previous_date"].to_list() == [date(2026, 10, 14), date(2026, 10, 15)]
    assert rows["holdings_date"].null_count() == 2
    assert rows["portfolio_id"].null_count() == 2


def test_only_shared_price_dates_are_used_and_gaps_are_explicit(reader, r2):
    prices = prices_df([200.0, 200.0, 220.0, 198.0]).filter(
        pl.col("date") != date(2026, 10, 15)
    )
    r2.put_df(prices_key("B.US"), prices)
    portfolio = Portfolio(
        holdings=[{"symbol": "A.US", "weight": 0.6}, {"symbol": "B.US", "weight": -0.4}]
    )
    rows = calculate(reader, portfolio)
    assert rows["date"].to_list() == [date(2026, 10, 14), date(2026, 10, 16)]
    assert rows["previous_date"].to_list() == [date(2026, 10, 13), date(2026, 10, 14)]
    assert rows["return"].to_list() == pytest.approx([0.06, -0.002])


@pytest.mark.parametrize(
    "params, symbol, expected",
    [
        ({"start_date": "2026-10-17"}, "A.US", "start_date must be"),
        ({}, "MISSING.US", "No prices_eod data"),
    ],
)
def test_invalid_history_has_an_explicit_failure(reader, params, symbol, expected):
    portfolio = Portfolio(holdings=[{"symbol": symbol, "weight": 1}])
    rows, outcomes = RETURNS.calculate(params, AS_OF, [portfolio], reader)
    assert rows.is_empty()
    assert outcomes[0].status == "failed"
    assert outcomes[0].error.startswith(expected)


@pytest.mark.parametrize(
    "prices, expected",
    [
        ([100], "No shared return history"),
        ([100, 0, 100], "Prices produce non-finite returns"),
    ],
)
def test_insufficient_or_non_finite_history_is_not_returned(r2, prices, expected):
    r2.put_df(prices_key("A.US"), prices_df(prices))
    portfolio = Portfolio(holdings=[{"symbol": "A.US", "weight": 1}])
    rows, outcomes = RETURNS.calculate({}, AS_OF, [portfolio], SymbolReader(r2, BUCKET))
    assert rows.is_empty()
    assert outcomes[0].error.startswith(expected)


def test_params_reject_unknown_fields_and_malformed_dates():
    for params in [{"window": 10}, {"start_date": "2026-02-30"}]:
        with pytest.raises(ValueError):
            RETURNS.validate_params(params)
