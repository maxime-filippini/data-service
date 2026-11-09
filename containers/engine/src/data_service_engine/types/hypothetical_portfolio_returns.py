"""Historical returns using the holdings selected at one calculation date."""

from datetime import date

import numpy as np
import polars as pl
from pydantic import BaseModel, ConfigDict, Field

from ..framework import CalculationError, CalculationType, Context
from ..returns import price_returns

OUTPUT = {
    "date": pl.Date,
    "previous_date": pl.Date,
    "return": pl.Float64,
    "holdings_date": pl.Date,
}


class Params(BaseModel):
    """History selection for a fixed-exposure return series.

    start_date bounds return observation dates, inclusively. Omit it for all
    available shared history. Weights are used as supplied without normalization;
    negative exposures and sums other than one retain their meaning.
    """

    model_config = ConfigDict(extra="forbid")

    start_date: date | None = Field(
        None,
        description="First return observation date, inclusive; default is all available history.",
    )


def run(params: Params, ctx: Context) -> pl.DataFrame:
    """Apply calculation-date weights to every historical return interval.

    Saved snapshots before/after the selected snapshot never change past
    exposures. Constant weights imply rebalancing each interval; this is a
    hypothetical series, rather than realized performance or buy-and-hold drift.
    """
    assert ctx.portfolio is not None
    if params.start_date is not None and params.start_date > ctx.as_of:
        raise CalculationError("start_date must be on or before the calculation date")
    snapshot = ctx.portfolio.holdings_at(ctx.as_of)
    symbols = snapshot.symbols
    returns = price_returns(ctx, symbols)
    if params.start_date is not None:
        returns = returns.filter(pl.col("date") >= params.start_date)
    if returns.is_empty():
        raise CalculationError(f"No shared return history up to {ctx.as_of}")
    matrix = returns.select(symbols).to_numpy()
    if not np.isfinite(matrix).all():
        raise CalculationError("Prices produce non-finite returns")
    weights = np.array([snapshot.weights[symbol] for symbol in symbols])
    values = matrix @ weights
    if not np.isfinite(values).all():
        raise CalculationError("Portfolio weights produce non-finite returns")
    return returns.select("date", "previous_date").with_columns(
        pl.Series("return", values),
        pl.lit(snapshot.holdings_date, pl.Date).alias("holdings_date"),
    )


# Registration depends on the params model and implementation above.
TYPE = CalculationType(
    name="hypothetical_portfolio_returns",
    description="Historical constant-weight returns of holdings selected at the calculation date.",
    params=Params,
    output=OUTPUT,
    run=run,
    takes_portfolio=True,
)
