"""Functional result formatting for independent portfolio calculations.

These helpers only transform completed rows and recorded outcomes. The caller
owns iteration, data acquisition, computation and exception handling.
"""

from collections.abc import Mapping, Sequence

import polars as pl

from .framework import CalculationResult
from .models import PortfolioOutcome

RESERVED_COLUMNS = {"as_of", "portfolio_id", "portfolio_index"}


def portfolio_rows(
    rows: pl.DataFrame,
    output: Mapping[str, pl.DataType | type[pl.DataType]],
    portfolio_id: str | None,
    *,
    index: int | None = None,
) -> pl.DataFrame:
    """Validate/cast completed value columns and attach portfolio identifiers.

    An explicit index labels synchronous batch entries, including repeated IDs
    and inline compositions. Omitting it preserves the single/saved row shape.
    Exceptions propagate to the caller's normal error handling.
    """
    reserved = RESERVED_COLUMNS & output.keys()
    if reserved:
        raise ValueError(f"Portfolio output can't use {sorted(reserved)}")
    if not isinstance(rows, pl.DataFrame):
        raise TypeError(f"calculate returned {type(rows).__name__}, not a DataFrame")
    if set(rows.columns) != set(output):
        raise ValueError(
            f"calculate returned columns {sorted(rows.columns)}, "
            f"expected {sorted(output)}"
        )
    rows = rows.select(
        pl.lit(portfolio_id, pl.String).alias("portfolio_id"),
        *(pl.col(column).cast(dtype, strict=True) for column, dtype in output.items()),
    )
    if index is not None:
        rows = rows.with_columns(pl.lit(index, pl.Int64).alias("portfolio_index"))
    return rows


def portfolio_result(
    frames: Sequence[pl.DataFrame],
    outcomes: Sequence[PortfolioOutcome],
    output: Mapping[str, pl.DataType | type[pl.DataType]],
    *,
    indexed: bool = False,
) -> CalculationResult:
    """Combine already-computed frames and outcomes into an execution result.

    Every outcome must describe a computation already attempted by the caller.
    Successful frames must already have identifiers (via portfolio_rows).
    An all-failed execution retains a typed empty schema. No computation is
    invoked, no exception is caught and no storage is accessed by this helper.
    """
    if not outcomes:
        raise ValueError("At least one portfolio outcome is required")
    schema = {"portfolio_id": pl.String, **output}
    if indexed:
        schema["portfolio_index"] = pl.Int64
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
