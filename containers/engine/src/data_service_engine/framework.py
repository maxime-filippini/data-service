"""Calculation registration and one invocation per request.

Each type owns its execution flow and chooses its data and iteration helpers.
The registry supplies metadata and parameter/output validation, not a strategy
for portfolio, symbol or aggregate calculations.
"""

import importlib
import pkgutil
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from functools import cache
from types import ModuleType
from typing import Any, Literal

import polars as pl
from pydantic import BaseModel

from .errors import UnknownTypeError
from .market_data import SymbolLoader
from .models import Portfolio, PortfolioOutcome


@dataclass(frozen=True)
class Context:
    """Whole-request inputs supplied unchanged to a calculation implementation.

    Portfolios are selections, not an instruction to iterate. A type can use
    them independently, aggregate them or ignore them. mode records the caller's
    failure policy: saved runs may retain partial results, synchronous calls
    must return a complete result. load_symbol optionally substitutes local
    frames for canonical storage when a type calls market_data().
    """

    as_of: date
    portfolios: Sequence[Portfolio] = ()
    mode: Literal["saved", "single", "batch"] = "saved"
    load_symbol: SymbolLoader | None = field(default=None, repr=False)


@dataclass(frozen=True)
class CalculationResult:
    """Rows and execution outcome returned by one calculation invocation.

    The type owns identifying columns and optional per-portfolio outcomes.
    The framework stamps as_of and checks declared output columns. The runtime
    uses status to decide whether to persist rows; it does not infer success
    from portfolio outcomes, which symbol/aggregate types need not provide.
    """

    rows: pl.DataFrame
    status: Literal["completed", "partial", "failed"] = "completed"
    error: str | None = None
    portfolios: tuple[PortfolioOutcome, ...] = ()


@dataclass(frozen=True)
class CalculationType:
    """Metadata, parameter schema and entry point exported as module-level TYPE.

    run(params, ctx) is called exactly once with all request inputs and returns
    a CalculationResult. output declares required value columns and their
    types; identifying columns belong to the implementation. takes_portfolio
    is catalog/UI metadata and never selects an execution strategy.
    """

    name: str
    description: str
    params: type[BaseModel]
    output: Mapping[str, pl.DataType | type[pl.DataType]]
    run: Callable[[Any, Context], CalculationResult]
    takes_portfolio: bool = False

    def __post_init__(self):
        if not self.name.isidentifier() or self.name != self.name.lower():
            raise ValueError(f"Type name must be snake_case: {self.name!r}")
        if not self.output:
            raise ValueError(f"{self.name}: output needs at least one column")
        if "as_of" in self.output:
            raise ValueError(f"{self.name}: output can't use as_of")

    def describe(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "takesPortfolio": self.takes_portfolio,
            "paramsSchema": self.params.model_json_schema(),
            "output": {name: str(dtype) for name, dtype in self.output.items()},
        }

    def validate_params(self, params: Mapping[str, Any]) -> BaseModel:
        return self.params.model_validate(params)

    def calculate(self, params: Mapping[str, Any], ctx: Context) -> CalculationResult:
        """Validate params, invoke the type once and validate/stamp its rows.

        Types may add identifying columns such as symbol or portfolio_id. Their
        output declaration covers the required value columns; helper functions
        can enforce a stricter schema for individual computation steps.
        """
        result = self.run(self.validate_params(params), ctx)
        if not isinstance(result, CalculationResult):
            raise TypeError(
                f"run returned {type(result).__name__}, not a CalculationResult"
            )
        if not isinstance(result.rows, pl.DataFrame):
            raise TypeError("CalculationResult.rows must be a DataFrame")
        missing = self.output.keys() - set(result.rows.columns)
        if missing:
            raise ValueError(f"run omitted output columns {sorted(missing)}")
        rows = result.rows.with_columns(
            *(
                pl.col(name).cast(dtype, strict=True)
                for name, dtype in self.output.items()
            )
        ).select(pl.lit(ctx.as_of, pl.Date).alias("as_of"), pl.exclude("as_of"))
        return replace(result, rows=rows)


def discover(package: ModuleType) -> dict[str, CalculationType]:
    """Import every module in `package` and collect its `TYPE`.

    Modules whose name starts with `_` are skipped, for shared helpers.
    """
    found: dict[str, CalculationType] = {}
    for module_info in pkgutil.iter_modules(package.__path__):
        if module_info.name.startswith("_"):
            continue
        module = importlib.import_module(f"{package.__name__}.{module_info.name}")
        calculation_type = getattr(module, "TYPE", None)
        if not isinstance(calculation_type, CalculationType):
            raise TypeError(f"{module.__name__} has no TYPE = CalculationType(...)")
        if calculation_type.name in found:
            raise ValueError(f"Two types are named {calculation_type.name!r}")
        found[calculation_type.name] = calculation_type
    return dict(sorted(found.items()))


@cache
def registry() -> dict[str, CalculationType]:
    from . import types

    return discover(types)


def get_type(name: str) -> CalculationType:
    try:
        return registry()[name]
    except KeyError:
        raise UnknownTypeError(f"Unknown calculation type {name!r}") from None
