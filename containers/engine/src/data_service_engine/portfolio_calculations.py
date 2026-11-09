"""Opt-in independent portfolio execution shared by calculation types.

Types choose this helper when each portfolio produces independent rows. An
aggregate calculation can instead consume ctx.portfolios in one computation.
Data acquisition stays with the caller, so a shared reader can span the loop.
"""

import logging
from collections.abc import Callable, Mapping

import polars as pl

from .errors import BatchCalculationFailed, CalculationError, describe_error
from .framework import CalculationResult, Context
from .models import Portfolio, PortfolioOutcome

logger = logging.getLogger(__name__)
RESERVED_COLUMNS = {"as_of", "portfolio_id", "portfolio_index"}


def for_portfolios(
    ctx: Context,
    output: Mapping[str, pl.DataType | type[pl.DataType]],
    calculate: Callable[[Portfolio], pl.DataFrame],
    *,
    name: str,
) -> CalculationResult:
    """Run calculate() for each selection visible at ctx.as_of.

    Validates each frame against output, adds portfolio_id and (for synchronous
    batches) portfolio_index. Saved runs retain successful rows and per-portfolio
    failures; synchronous batches fail atomically with an indexed error. Single
    synchronous failures return failed status for the normal runtime error path.
    No data is loaded or written here; calculate() owns its own requirements.
    """
    if not ctx.portfolios:
        raise CalculationError(f"{name} needs at least one portfolio")
    reserved = RESERVED_COLUMNS & output.keys()
    if reserved:
        raise ValueError(f"Portfolio output can't use {sorted(reserved)}")
    schema = {"portfolio_id": pl.String, **output}
    if ctx.mode == "batch":
        schema["portfolio_index"] = pl.Int64
    frames, outcomes = [], []
    for index, portfolio in enumerate(ctx.portfolios):
        try:
            known = portfolio.until(ctx.as_of)
            if not known.snapshots:
                raise CalculationError(f"No holdings on or before {ctx.as_of}")
            rows = calculate(known)
            if not isinstance(rows, pl.DataFrame):
                raise TypeError(
                    f"calculate returned {type(rows).__name__}, not a DataFrame"
                )
            if set(rows.columns) != set(output):
                raise ValueError(
                    f"calculate returned columns {sorted(rows.columns)}, "
                    f"expected {sorted(output)}"
                )
            rows = rows.select(
                pl.lit(portfolio.id, pl.String).alias("portfolio_id"),
                *(
                    pl.col(column).cast(dtype, strict=True)
                    for column, dtype in output.items()
                ),
            )
            if ctx.mode == "batch":
                rows = rows.with_columns(
                    pl.lit(index, pl.Int64).alias("portfolio_index")
                )
        except Exception as error:
            logger.exception("%s failed for portfolio %s", name, portfolio.id)
            if ctx.mode == "batch":
                raise BatchCalculationFailed(index, portfolio.id, error) from error
            outcomes.append(
                PortfolioOutcome(
                    portfolio_id=portfolio.id,
                    status="failed",
                    error=describe_error(error),
                )
            )
            continue
        frames.append(rows)
        outcomes.append(
            PortfolioOutcome(
                portfolio_id=portfolio.id, status="completed", row_count=rows.height
            )
        )
    failed = [outcome for outcome in outcomes if outcome.status == "failed"]
    status, error = "completed", None
    if len(failed) == len(outcomes):
        status = "failed"
        error = (
            failed[0].error
            if len(failed) == 1
            else f"All {len(failed)} portfolios failed"
        )
    elif failed:
        status = "partial"
    return CalculationResult(
        rows=pl.concat(frames) if frames else pl.DataFrame(schema=schema),
        status=status,
        error=error,
        portfolios=tuple(outcomes),
    )
