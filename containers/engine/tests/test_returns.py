from datetime import date

import polars as pl
import pytest

from data_service_engine.errors import CalculationError
from data_service_engine.returns import price_returns


def test_alignment_uses_only_requested_symbols_and_keeps_explicit_intervals():
    prices = pl.DataFrame(
        {
            "symbol": ["A", "A", "A", "B", "B", "UNUSED"],
            "date": [date(2026, 10, day) for day in [13, 14, 16, 13, 16, 14]],
            "adjusted_close": [100.0, 110.0, 121.0, 200.0, 180.0, 1.0],
        }
    )
    returns = price_returns(prices, ["A", "B"])
    assert returns.columns == ["date", "previous_date", "A", "B"]
    assert returns["date"].to_list() == [date(2026, 10, 16)]
    assert returns["previous_date"].to_list() == [date(2026, 10, 13)]
    assert returns["A"].to_list() == pytest.approx([0.21])
    assert returns["B"].to_list() == pytest.approx([-0.1])
    assert prices.height == 6

    with pytest.raises(
        CalculationError, match="No prices in selected history for MISSING"
    ):
        price_returns(prices, ["A", "MISSING"])
