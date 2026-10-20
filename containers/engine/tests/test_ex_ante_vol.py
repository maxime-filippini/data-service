import math
import statistics
from datetime import date

import pytest

from data_service_engine.framework import get_type
from data_service_engine.models import Portfolio
from data_service_engine.storage import SymbolReader

from .conftest import BUCKET, prices_df, prices_key

AS_OF = date(2026, 10, 16)
VOL = get_type("ex_ante_vol")
RETURNS = {
    "A.US": [0.01, -0.02, 0.015, 0.0, -0.005, 0.02, -0.01, 0.005],
    "B.US": [0.002, 0.001, -0.003, 0.004, 0.0, -0.001, 0.002, 0.003],
}


def closes(returns, start=100.0):
    prices = [start]
    for r in returns:
        prices.append(prices[-1] * (1 + r))
    return prices


@pytest.fixture
def reader(r2):
    for symbol, returns in RETURNS.items():
        r2.put_df(prices_key(symbol), prices_df(closes(returns), end=AS_OF))
    return SymbolReader(r2, BUCKET)


def portfolio(weights, id="p1"):
    return Portfolio(
        id=id, holdings=[{"symbol": s, "weight": w} for s, w in weights.items()]
    )


def calculate(reader, params, weights, as_of=AS_OF):
    rows, outcomes = VOL.calculate(params, as_of, [portfolio(weights)], reader)
    assert outcomes[0].error is None
    return rows.row(0, named=True)


def portfolio_returns(weights, last=None):
    series = [
        sum(w * RETURNS[s][i] for s, w in weights.items())
        for i in range(len(RETURNS["A.US"]))
    ]
    return series[-last:] if last else series


def test_sample_volatility_matches_the_portfolio_return_series(reader):
    weights = {"A.US": 0.6, "B.US": -0.4}
    row = calculate(reader, {"window": 8, "annualisation": 252}, weights)
    expected = statistics.stdev(portfolio_returns(weights)) * math.sqrt(252)
    assert row["volatility"] == pytest.approx(expected)
    assert row["observations"] == 8
    assert row["window_end"] == AS_OF
    assert row["portfolio_id"] == "p1"


def test_ewma_uses_decaying_weights_and_a_zero_mean(reader):
    weights = {"A.US": 1.0}
    row = calculate(reader, {"window": 5, "decay": 0.9, "annualisation": 1}, weights)
    series = portfolio_returns(weights, last=5)
    decay = [0.9**age for age in range(4, -1, -1)]
    variance = sum(d * r * r for d, r in zip(decay, series)) / sum(decay)
    assert row["volatility"] == pytest.approx(math.sqrt(variance))
    assert row["observations"] == 5


def test_normalised_weights_are_divided_by_their_sum(reader):
    raw = calculate(reader, {"window": 8}, {"A.US": 2.0, "B.US": 2.0})
    normalised = calculate(
        reader, {"window": 8, "normalise_weights": True}, {"A.US": 2.0, "B.US": 2.0}
    )
    assert normalised["volatility"] == pytest.approx(raw["volatility"] / 4)


def test_a_past_as_of_date_ignores_later_prices(reader):
    row = calculate(reader, {"window": 3}, {"A.US": 1.0}, as_of=date(2026, 10, 14))
    assert row["window_end"] == date(2026, 10, 14)
    expected = statistics.stdev(RETURNS["A.US"][3:6]) * math.sqrt(252)
    assert row["volatility"] == pytest.approx(expected)


@pytest.mark.parametrize(
    "params, weights, error",
    [
        ({"window": 9}, {"A.US": 1.0}, "Only 8 daily returns up to 2026-10-16, need 9"),
        ({"window": 2}, {"MISSING.US": 1.0}, "No prices_eod data for MISSING.US"),
        (
            {"window": 2, "normalise_weights": True},
            {"A.US": 1.0, "B.US": -1.0},
            "Weights sum to zero",
        ),
    ],
)
def test_failures_explain_themselves(reader, params, weights, error):
    _, outcomes = VOL.calculate(params, AS_OF, [portfolio(weights)], reader)
    assert outcomes[0].status == "failed"
    assert outcomes[0].error.startswith(error)


def test_params_reject_unknown_fields_and_bad_values():
    for params in [{"windw": 10}, {"window": 1}, {"decay": 1}, {"annualisation": 0}]:
        with pytest.raises(ValueError):
            VOL.validate_params(params)


def test_uses_the_snapshot_in_effect_at_the_as_of_date(reader):
    history = Portfolio.model_validate(
        {
            "id": "p1",
            "snapshots": [
                {
                    "holdingsDate": "2026-10-01",
                    "holdings": [{"symbol": "A.US", "weight": 1}],
                },
                {
                    "holdingsDate": "2026-10-14",
                    "holdings": [{"symbol": "B.US", "weight": 1}],
                },
                # After the as-of date, so it must be ignored.
                {
                    "holdingsDate": "2026-10-16",
                    "holdings": [{"symbol": "A.US", "weight": 5}],
                },
            ],
        }
    )
    rows, _ = VOL.calculate({"window": 3}, date(2026, 10, 15), [history], reader)
    row = rows.row(0, named=True)
    assert row["holdings_date"] == date(2026, 10, 14)
    expected = statistics.stdev(RETURNS["B.US"][4:7]) * math.sqrt(252)
    assert row["volatility"] == pytest.approx(expected)
