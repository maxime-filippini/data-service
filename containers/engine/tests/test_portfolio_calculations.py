from datetime import date

import polars as pl
import pytest

from data_service_engine.errors import CalculationError
from data_service_engine.framework import Context
from data_service_engine.models import Portfolio
from data_service_engine.portfolio_calculations import for_portfolios

AS_OF = date(2026, 10, 16)
OUTPUT = {"total": pl.Float64}


def portfolio(id):
    return Portfolio(id=id, holdings=[{"symbol": "A", "weight": 1}])


def total_weight(portfolio):
    if portfolio.id == "broken":
        raise RuntimeError("boom")
    return pl.DataFrame({"total": [1.0]})


def test_opt_in_iteration_reports_partial_failures_and_preserves_empty_schema():
    result = for_portfolios(
        Context(AS_OF, [portfolio("broken"), portfolio("ok")]),
        OUTPUT,
        total_weight,
        name="total_weight",
    )
    assert result.status == "partial"
    assert result.rows.to_dicts() == [{"portfolio_id": "ok", "total": 1.0}]
    assert [(o.portfolio_id, o.status, o.row_count) for o in result.portfolios] == [
        ("broken", "failed", 0),
        ("ok", "completed", 1),
    ]
    assert result.portfolios[0].error == "RuntimeError: boom"
    failed = for_portfolios(
        Context(AS_OF, [portfolio("broken")]), OUTPUT, total_weight, name="total_weight"
    )
    assert failed.status == "failed"
    assert failed.error == "RuntimeError: boom"
    assert failed.rows.schema == pl.Schema({"portfolio_id": pl.String, **OUTPUT})


@pytest.mark.parametrize(
    "rows, error",
    [
        (pl.DataFrame({"other": [1.0]}), "ValueError: calculate returned columns"),
        (pl.DataFrame({"total": ["text"]}), "InvalidOperationError"),
        ({"total": 1.0}, "TypeError: calculate returned dict"),
    ],
)
def test_individual_output_is_validated_inside_the_failure_policy(rows, error):
    result = for_portfolios(
        Context(AS_OF, [portfolio("a")]), OUTPUT, lambda p: rows, name="total_weight"
    )
    assert result.status == "failed"
    assert result.portfolios[0].error.startswith(error)


def test_portfolio_requirement_belongs_to_the_opt_in_helper():
    with pytest.raises(CalculationError, match="needs at least one portfolio"):
        for_portfolios(Context(AS_OF), OUTPUT, total_weight, name="total_weight")
