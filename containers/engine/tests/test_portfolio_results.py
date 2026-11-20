import polars as pl
import pytest

from data_service_engine.models import PortfolioOutcome
from data_service_engine.portfolio_results import portfolio_result, portfolio_rows

OUTPUT = {"total": pl.Float64}


def test_completed_rows_preserve_inline_and_duplicate_batch_identities():
    values = pl.DataFrame({"total": [1, 2]})
    first = portfolio_rows(values, OUTPUT, "same", index=0)
    inline = portfolio_rows(values, OUTPUT, None, index=1)
    repeated = portfolio_rows(values, OUTPUT, "same", index=2)
    result = portfolio_result(
        [first, inline, repeated],
        [
            PortfolioOutcome(portfolio_id=id, status="completed", row_count=2)
            for id in ["same", None, "same"]
        ],
        OUTPUT,
        indexed=True,
    )
    assert result.status == "completed"
    assert result.rows.schema == pl.Schema(
        {"portfolio_id": pl.String, "total": pl.Float64, "portfolio_index": pl.Int64}
    )
    assert result.rows["portfolio_index"].to_list() == [0, 0, 1, 1, 2, 2]
    assert result.rows["portfolio_id"].to_list() == [
        "same",
        "same",
        None,
        None,
        "same",
        "same",
    ]


def test_recorded_failures_produce_partial_and_typed_empty_results():
    failed = PortfolioOutcome(
        portfolio_id="broken", status="failed", error="Missing data"
    )
    success = PortfolioOutcome(portfolio_id="ok", status="completed", row_count=1)
    rows = portfolio_rows(pl.DataFrame({"total": [1.0]}), OUTPUT, "ok")
    partial = portfolio_result([rows], [failed, success], OUTPUT)
    assert partial.status == "partial"
    assert partial.rows.to_dicts() == [{"portfolio_id": "ok", "total": 1.0}]
    empty = portfolio_result([], [failed], OUTPUT)
    assert empty.status == "failed"
    assert empty.error == "Missing data"
    assert empty.rows.schema == pl.Schema({"portfolio_id": pl.String, **OUTPUT})
    assert empty.rows.is_empty()


@pytest.mark.parametrize(
    "rows, error_type, message",
    [
        (pl.DataFrame({"other": [1.0]}), ValueError, "calculate returned columns"),
        (
            pl.DataFrame({"total": ["text"]}),
            pl.exceptions.InvalidOperationError,
            "conversion",
        ),
        ({"total": 1.0}, TypeError, "calculate returned dict"),
    ],
)
def test_invalid_value_columns_raise_to_the_callers_error_handler(
    rows, error_type, message
):
    with pytest.raises(error_type, match=message):
        portfolio_rows(rows, OUTPUT, "a")
