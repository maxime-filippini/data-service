"""Historical returns using the holdings selected at one calculation date."""

from datetime import date

import numpy as np
import polars as pl
from pydantic import BaseModel, ConfigDict, Field

from ..errors import CalculationError
from ..framework import CalculationResult, CalculationType, Context
from ..market_data import MarketData, market_data
from ..models import Portfolio
from ..portfolio_calculations import for_portfolios
from ..returns import price_returns

NAME = "hypothetical_portfolio_returns"
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


def calculate_portfolio(
    params: Params, data: MarketData, portfolio: Portfolio
) -> pl.DataFrame:
    """Apply calculation-date weights to every historical return interval.

    Saved snapshots before/after the selected snapshot never change past
    exposures. Constant weights imply rebalancing each interval; this is a
    hypothetical series, rather than realized performance or buy-and-hold drift.
    """
    if params.start_date is not None and params.start_date > data.as_of:
        raise CalculationError("start_date must be on or before the calculation date")
    snapshot = portfolio.holdings_at(data.as_of)
    symbols = snapshot.symbols
    returns = price_returns(data, symbols)
    if params.start_date is not None:
        returns = returns.filter(pl.col("date") >= params.start_date)
    if returns.is_empty():
        raise CalculationError(f"No shared return history up to {data.as_of}")
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


def run(params: Params, ctx: Context) -> CalculationResult:
    """Choose shared data access and independent portfolio execution explicitly."""
    with market_data(ctx.as_of, ctx.load_symbol) as data:
        return for_portfolios(
            ctx,
            OUTPUT,
            lambda portfolio: calculate_portfolio(params, data, portfolio),
            name=NAME,
        )


# Registration depends on the params model and implementation above.
TYPE = CalculationType(
    name=NAME,
    description="Historical constant-weight returns of holdings selected at the calculation date.",
    params=Params,
    output=OUTPUT,
    run=run,
    takes_portfolio=True,
)
