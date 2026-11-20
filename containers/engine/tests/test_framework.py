import sys
from datetime import date

import polars as pl
import pytest
from pydantic import BaseModel, ValidationError

from data_service_engine import runtime, storage
from data_service_engine.errors import CalculationFailed, UnknownTypeError
from data_service_engine.framework import (
    CalculationResult,
    CalculationType,
    Context,
    discover,
    get_type,
)
from data_service_engine.models import CalculateRequest, Portfolio, RunRequest

AS_OF = date(2026, 10, 16)


class Params(BaseModel):
    scale: float = 1


def portfolio(id, *weights):
    return Portfolio(
        id=id,
        holdings=[{"symbol": f"S{i}", "weight": w} for i, w in enumerate(weights)],
    )


def test_aggregate_runs_once_with_all_inputs_regardless_of_catalog_hint(monkeypatch):
    calls = []

    def unexpected_settings():
        raise AssertionError("runtime acquired data without being asked")

    monkeypatch.setattr(storage, "load_settings", unexpected_settings)

    def aggregate(params, ctx):
        calls.append(ctx)
        total = sum(
            sum(p.holdings_at(ctx.as_of).weights.values()) for p in ctx.portfolios
        )
        return CalculationResult(pl.DataFrame({"total": [total * params.scale]}))

    calc = CalculationType(
        name="aggregate",
        description="",
        params=Params,
        output={"total": pl.Float64},
        run=aggregate,
        takes_portfolio=True,
    )
    monkeypatch.setattr(runtime, "get_type", lambda name: calc)
    request = CalculateRequest(
        type="aggregate",
        params={"scale": 2},
        as_of=AS_OF,
        portfolios=[portfolio("a", 1, 2), portfolio("b", 0.5)],
    )
    rows = runtime.calculate(request)
    assert len(calls) == 1
    assert len(calls[0].portfolios) == 2
    assert calls[0].mode == "batch"
    assert rows.to_dicts() == [{"as_of": AS_OF, "total": 7.0}]
    # No R2 configuration is present: this calculation did not ask for data.
    assert "portfolio_id" not in rows.columns
    assert "portfolio_index" not in rows.columns
    with pytest.raises(ValidationError):
        calc.calculate({"scale": "x"}, Context(AS_OF))
    assert len(calls) == 1


@pytest.mark.parametrize(
    "result, error_type, message",
    [
        (
            CalculationResult(pl.DataFrame({"other": [1.0]})),
            ValueError,
            "omitted output columns",
        ),
        (
            CalculationResult(pl.DataFrame({"value": ["text"]})),
            pl.exceptions.InvalidOperationError,
            "conversion",
        ),
        ({"value": 1.0}, TypeError, "not a CalculationResult"),
        (CalculationResult({"value": 1.0}), TypeError, "must be a DataFrame"),
    ],
)
def test_invalid_results_are_rejected(result, error_type, message):
    calc = CalculationType(
        name="bad",
        description="",
        params=Params,
        output={"value": pl.Float64},
        run=lambda params, ctx: result,
    )
    with pytest.raises(error_type, match=message):
        calc.calculate({}, Context(AS_OF))


def test_type_definitions_are_checked():
    common = {"description": "", "params": Params, "run": lambda params, ctx: None}
    with pytest.raises(ValueError, match="snake_case"):
        CalculationType(name="Ex Ante", output={"x": pl.Int64}, **common)
    with pytest.raises(ValueError, match="as_of"):
        CalculationType(name="x", output={"as_of": pl.Date}, **common)
    with pytest.raises(ValueError, match="at least one column"):
        CalculationType(name="x", output={}, **common)


@pytest.mark.parametrize("status", ["partial", "failed"])
def test_synchronous_dispatch_refuses_incomplete_results_without_portfolio_outcomes(
    monkeypatch, status
):
    calc = CalculationType(
        name="incomplete",
        description="",
        params=Params,
        output={"value": pl.Float64},
        run=lambda params, ctx: CalculationResult(
            pl.DataFrame({"value": [1.0]}), status=status, error="Missing inputs"
        ),
    )
    monkeypatch.setattr(runtime, "get_type", lambda name: calc)
    request = CalculateRequest(type=calc.name, params={}, as_of=AS_OF)
    with pytest.raises(CalculationFailed, match="Missing inputs"):
        runtime.calculate(request)

    if status == "failed":

        def unexpected_settings():
            raise AssertionError("A failed result must not open storage")

        monkeypatch.setattr(storage, "load_settings", unexpected_settings)
        saved = runtime.run(
            RunRequest(
                run_id="failed",
                type=calc.name,
                params={},
                as_of=AS_OF,
                output_key="calculation=failed/data.parquet",
            )
        )
        assert saved.status == "failed"
        assert saved.error == "Missing inputs"
        assert saved.portfolios == ()
        assert saved.output_etag is None


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
