"""What a calculation type is, how types are found, and how one is run.

A type is a module in `data_service_engine.types` with a module-level
`TYPE = CalculationType(...)`. Nothing else needs to change to add one.
"""

import importlib
import logging
import pkgutil
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from functools import cache
from types import ModuleType
from typing import Any

import polars as pl
from pydantic import BaseModel, ValidationError

from .errors import CalculationError, MissingDataError, UnknownTypeError
from .models import Portfolio, PortfolioOutcome

__all__ = ["CalculationError", "MissingDataError", "UnknownTypeError"]

logger = logging.getLogger(__name__)

# Columns the framework adds to every result row.
RESERVED_COLUMNS = {"as_of": pl.Date, "portfolio_id": pl.String}

# Reads the whole (dataset, symbol) Parquet object. Raises MissingDataError.
SymbolLoader = Callable[[str, str], pl.DataFrame]


def describe_error(error: Exception) -> str:
    if isinstance(error, CalculationError):
        message = str(error)
    elif isinstance(error, ValidationError):
        message = f"Invalid {error.title}: " + "; ".join(
            f"{'.'.join(map(str, e['loc'])) or 'value'}: {e['msg']}"
            for e in error.errors()
        )
    else:
        message = f"{type(error).__name__}: {error}"
    return message[:500]


@dataclass(frozen=True)
class Context:
    """What a type gets besides its params."""

    as_of: date
    portfolio: Portfolio | None
    _load_symbol: SymbolLoader = field(repr=False)

    def load(
        self,
        dataset: str,
        symbols: Sequence[str],
        start: date | None = None,
        end: date | None = None,
    ) -> pl.DataFrame:
        """Rows of `dataset` for `symbols` between `start` and `end`, inclusive.

        Returns a `symbol` column plus the dataset's columns, sorted by symbol
        and date. Never returns rows after `as_of`, so a past as-of date only
        sees data up to that date.
        """
        end = self.as_of if end is None else min(end, self.as_of)
        dfs = []
        for symbol in dict.fromkeys(symbols):
            df = self._load_symbol(dataset, symbol).filter(pl.col("date") <= end)
            if start is not None:
                df = df.filter(pl.col("date") >= start)
            dfs.append(df.select(pl.lit(symbol).alias("symbol"), pl.all()))
        if not dfs:
            raise ValueError("Load at least one symbol")
        return pl.concat(dfs).sort("symbol", "date")


@dataclass(frozen=True)
class CalculationType:
    """One kind of calculation.

    - `params`: a Pydantic model for the saved params.
    - `output`: the columns of each result row (`as_of` and `portfolio_id`
      are added by the framework).
    - `run(params, ctx)`: returns a DataFrame with exactly the `output` columns.
    - `takes_portfolio`: run once per portfolio, with `ctx.portfolio` set to
      its snapshots up to `as_of`. The type picks the holdings it needs.
    """

    name: str
    description: str
    params: type[BaseModel]
    output: Mapping[str, pl.DataType | type[pl.DataType]]
    run: Callable[[Any, Context], pl.DataFrame]
    takes_portfolio: bool = False

    def __post_init__(self):
        if not self.name.isidentifier() or self.name != self.name.lower():
            raise ValueError(f"Type name must be snake_case: {self.name!r}")
        if not self.output:
            raise ValueError(f"{self.name}: output needs at least one column")
        reserved = RESERVED_COLUMNS.keys() & self.output.keys()
        if reserved:
            raise ValueError(f"{self.name}: output can't use {sorted(reserved)}")

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

    def result_schema(self) -> dict[str, pl.DataType | type[pl.DataType]]:
        return {**RESERVED_COLUMNS, **self.output}

    def calculate(
        self,
        params: Mapping[str, Any],
        as_of: date,
        portfolios: Sequence[Portfolio],
        load_symbol: SymbolLoader,
    ) -> tuple[pl.DataFrame, list[PortfolioOutcome]]:
        """Run once per portfolio (or once, without one).

        One portfolio failing doesn't stop the others; its outcome holds the
        error. Invalid params or the wrong number of portfolios raise.
        """
        validated = self.validate_params(params)

        if self.takes_portfolio and not portfolios:
            raise CalculationError(f"{self.name} needs at least one portfolio")
        if not self.takes_portfolio and portfolios:
            raise CalculationError(f"{self.name} doesn't take a portfolio")

        dfs, outcomes = [], []
        for portfolio in portfolios or [None]:
            portfolio_id = portfolio.id if portfolio else None
            try:
                ctx = Context(as_of, _known_on(portfolio, as_of), load_symbol)
                df = self._finish(self.run(validated, ctx), as_of, portfolio_id)
            except Exception as error:
                logger.exception("%s failed for portfolio %s", self.name, portfolio_id)
                outcomes.append(
                    PortfolioOutcome(
                        portfolio_id=portfolio_id,
                        status="failed",
                        error=describe_error(error),
                    )
                )
                continue
            dfs.append(df)
            outcomes.append(
                PortfolioOutcome(
                    portfolio_id=portfolio_id,
                    status="completed",
                    row_count=df.height,
                )
            )

        schema = self.result_schema()
        result = pl.concat(dfs) if dfs else pl.DataFrame(schema=schema)
        return result, outcomes

    def _finish(self, frame: Any, as_of: date, portfolio_id: str | None):
        if not isinstance(frame, pl.DataFrame):
            raise TypeError(f"run returned {type(frame).__name__}, not a DataFrame")
        if set(frame.columns) != set(self.output):
            raise ValueError(
                f"run returned columns {sorted(frame.columns)}, "
                f"expected {sorted(self.output)}"
            )
        return frame.select(
            pl.lit(as_of, pl.Date).alias("as_of"),
            pl.lit(portfolio_id, pl.String).alias("portfolio_id"),
            *(
                pl.col(name).cast(dtype, strict=True)
                for name, dtype in self.output.items()
            ),
        )


def _known_on(portfolio: Portfolio | None, as_of: date) -> Portfolio | None:
    """The portfolio without snapshots dated after `as_of`."""
    if portfolio is None:
        return None
    known = portfolio.until(as_of)
    if not known.snapshots:
        raise CalculationError(f"No holdings on or before {as_of}")
    return known


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
