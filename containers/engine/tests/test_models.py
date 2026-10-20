from datetime import date

import pytest
from pydantic import ValidationError

from data_service_engine.errors import CalculationError
from data_service_engine.models import Portfolio

JAN, FEB, MAR = date(2026, 1, 30), date(2026, 2, 27), date(2026, 3, 31)


def snapshot(day, **weights):
    return {
        "holdingsDate": day.isoformat(),
        "holdings": [{"symbol": s, "weight": w} for s, w in weights.items()],
    }


@pytest.fixture
def portfolio():
    # Sent out of order on purpose.
    return Portfolio.model_validate(
        {
            "id": "p1",
            "snapshots": [
                snapshot(MAR, A=1.0),
                snapshot(JAN, A=0.5, B=0.5),
                snapshot(FEB, B=1.0, C=2.0),
            ],
        }
    )


def test_snapshots_are_sorted_by_date(portfolio):
    assert [s.holdings_date for s in portfolio.snapshots] == [JAN, FEB, MAR]
    assert portfolio.symbols == ["A", "B", "C"]


def test_holdings_stay_in_effect_from_their_close_until_the_next_snapshot(portfolio):
    assert portfolio.holdings_at(JAN).holdings_date == JAN
    assert portfolio.holdings_at(date(2026, 2, 26)).holdings_date == JAN
    assert portfolio.holdings_at(FEB).weights == {"B": 1.0, "C": 2.0}
    assert portfolio.holdings_at(date(2027, 1, 1)).holdings_date == MAR
    with pytest.raises(CalculationError, match="No holdings on or before 2026-01-29"):
        portfolio.holdings_at(date(2026, 1, 29))


def test_snapshots_between_include_the_one_in_effect_at_the_start(portfolio):
    def dates(start, end):
        return [s.holdings_date for s in portfolio.snapshots_between(start, end)]

    assert dates(date(2026, 2, 10), date(2026, 3, 10)) == [JAN, FEB]
    assert dates(FEB, MAR) == [FEB, MAR]
    assert dates(date(2026, 1, 1), date(2026, 2, 1)) == [JAN]
    assert dates(date(2025, 1, 1), date(2025, 12, 31)) == []

    df = portfolio.holdings_df(date(2026, 2, 10), date(2026, 3, 10))
    assert df.rows() == [
        (JAN, "A", 0.5),
        (JAN, "B", 0.5),
        (FEB, "B", 1.0),
        (FEB, "C", 2.0),
    ]


def test_until_drops_later_snapshots(portfolio):
    assert [s.holdings_date for s in portfolio.until(FEB).snapshots] == [JAN, FEB]
    assert portfolio.until(date(2025, 1, 1)).snapshots == ()


def test_plain_holdings_are_one_snapshot_held_at_all_times():
    portfolio = Portfolio.model_validate({"holdings": [{"symbol": "A", "weight": 1}]})
    [only] = portfolio.snapshots
    assert only.holdings_date is None
    assert portfolio.holdings_at(date(1990, 1, 1)) is only
    assert portfolio.snapshots_between(JAN, MAR) == (only,)


@pytest.mark.parametrize(
    "snapshots",
    [
        [],
        [snapshot(JAN, A=1), snapshot(JAN, B=1)],
        [snapshot(JAN, A=1), {"holdings": [{"symbol": "A", "weight": 1}]}],
        [{"holdingsDate": "2026-01-30", "holdings": []}],
        [
            {
                "holdingsDate": "2026-01-30",
                "holdings": [
                    {"symbol": "A", "weight": 1},
                    {"symbol": "A", "weight": 2},
                ],
            }
        ],
    ],
)
def test_invalid_snapshots_are_rejected(snapshots):
    with pytest.raises(ValidationError):
        Portfolio.model_validate({"id": "p", "snapshots": snapshots})
