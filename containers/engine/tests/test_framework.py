import sys
from datetime import date

import polars as pl
import pytest
from pydantic import BaseModel, ValidationError

from data_service_engine.framework import (
    CalculationError,
    CalculationType,
    Context,
    UnknownTypeError,
    discover,
    get_type,
)
from data_service_engine.models import Portfolio

from .conftest import prices_frame

AS_OF = date(2026, 10, 16)


class Params(BaseModel):
    scale: float = 1


def total_weight(params: Params, ctx: Context) -> pl.DataFrame:
    assert ctx.portfolio is not None
    if ctx.portfolio.id == "broken":
        raise RuntimeError("boom")
    weights = ctx.portfolio.holdings_at(ctx.as_of).weights
    return pl.DataFrame({"total": [sum(weights.values()) * params.scale]})


TOTAL = CalculationType(
    name="total_weight",
    description="Sum of weights",
    params=Params,
    output={"total": pl.Float64},
    run=total_weight,
    takes_portfolio=True,
)


def portfolio(id, *weights):
    return Portfolio(
        id=id,
        holdings=[{"symbol": f"S{i}", "weight": w} for i, w in enumerate(weights)],
    )


def no_data(dataset, symbol):
    raise AssertionError("not loaded")


def test_runs_once_per_portfolio_and_adds_as_of_and_portfolio_id():
    rows, outcomes = TOTAL.calculate(
        {"scale": 2}, AS_OF, [portfolio("a", 1, 2), portfolio("b", 0.5)], no_data
    )
    assert rows.schema == pl.Schema(TOTAL.result_schema())
    assert rows.to_dicts() == [
        {"as_of": AS_OF, "portfolio_id": "a", "total": 6.0},
        {"as_of": AS_OF, "portfolio_id": "b", "total": 1.0},
    ]
    assert [(o.portfolio_id, o.status, o.row_count) for o in outcomes] == [
        ("a", "completed", 1),
        ("b", "completed", 1),
    ]


def test_one_failing_portfolio_does_not_stop_the_others():
    rows, outcomes = TOTAL.calculate(
        {}, AS_OF, [portfolio("broken", 1), portfolio("ok", 1)], no_data
    )
    assert rows["portfolio_id"].to_list() == ["ok"]
    assert outcomes[0].status == "failed"
    assert outcomes[0].error == "RuntimeError: boom"


def test_invalid_params_and_wrong_portfolio_count_raise():
    with pytest.raises(ValidationError):
        TOTAL.calculate({"scale": "x"}, AS_OF, [portfolio("a", 1)], no_data)
    with pytest.raises(CalculationError, match="needs at least one portfolio"):
        TOTAL.calculate({}, AS_OF, [], no_data)

    no_portfolio = CalculationType(
        name="constant",
        description="",
        params=Params,
        output={"value": pl.Int64},
        run=lambda params, ctx: pl.DataFrame({"value": [1]}),
    )
    with pytest.raises(CalculationError, match="doesn't take a portfolio"):
        no_portfolio.calculate({}, AS_OF, [portfolio("a", 1)], no_data)
    rows, _ = no_portfolio.calculate({}, AS_OF, [], no_data)
    assert rows.to_dicts() == [{"as_of": AS_OF, "portfolio_id": None, "value": 1}]


@pytest.mark.parametrize(
    "result, error",
    [
        (pl.DataFrame({"other": [1.0]}), "ValueError: run returned columns"),
        (pl.DataFrame({"total": ["text"]}), "InvalidOperationError"),
        ({"total": 1.0}, "TypeError: run returned dict"),
    ],
)
def test_output_must_match_the_declared_columns(result, error):
    bad = CalculationType(
        name="bad",
        description="",
        params=Params,
        output={"total": pl.Float64},
        run=lambda params, ctx: result,
        takes_portfolio=True,
    )
    _, outcomes = bad.calculate({}, AS_OF, [portfolio("a", 1)], no_data)
    assert outcomes[0].status == "failed"
    assert outcomes[0].error.startswith(error)


def test_type_definitions_are_checked():
    common = {"description": "", "params": Params, "run": total_weight}
    with pytest.raises(ValueError, match="snake_case"):
        CalculationType(name="Ex Ante", output={"x": pl.Int64}, **common)
    with pytest.raises(ValueError, match="as_of"):
        CalculationType(name="x", output={"as_of": pl.Date}, **common)
    with pytest.raises(ValueError, match="at least one column"):
        CalculationType(name="x", output={}, **common)


def test_context_load_never_returns_rows_after_as_of():
    frames = {
        "A": prices_frame([1, 2, 3, 4], end=date(2026, 10, 16)),
        "B": prices_frame([5, 6], end=date(2026, 10, 16)),
    }
    loaded = []

    def load(dataset, symbol):
        loaded.append((dataset, symbol))
        return frames[symbol]

    ctx = Context(date(2026, 10, 15), None, load)
    frame = ctx.load("prices_eod", ["B", "A", "B"], start=date(2026, 10, 13))
    assert frame.columns[0] == "symbol"
    assert frame.select("symbol", "date", "close").rows() == [
        ("A", date(2026, 10, 13), 1.0),
        ("A", date(2026, 10, 14), 2.0),
        ("A", date(2026, 10, 15), 3.0),
        ("B", date(2026, 10, 15), 5.0),
    ]
    assert loaded == [("prices_eod", "B"), ("prices_eod", "A")]
    # An explicit end after as_of is clamped too.
    assert ctx.load("prices_eod", ["A"], end=date(2027, 1, 1))["date"].max() == (
        date(2026, 10, 15)
    )


def test_discovers_types_and_rejects_bad_modules(tmp_path, monkeypatch):
    assert get_type("ex_ante_vol").takes_portfolio
    with pytest.raises(UnknownTypeError):
        get_type("missing")

    package = tmp_path / "fake_types"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "_helpers.py").write_text("")
    (package / "plain.py").write_text("x = 1\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    import fake_types

    with pytest.raises(TypeError, match="has no TYPE"):
        discover(fake_types)
    sys.modules.pop("fake_types.plain", None)
