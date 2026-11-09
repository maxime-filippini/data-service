"""Historical returns using the holdings selected at one calculation date."""

import logging
from datetime import date

import numpy as np
import polars as pl
from pydantic import BaseModel, ConfigDict, Field

from ..errors import BatchCalculationFailed, CalculationError, describe_error
from ..framework import CalculationResult, CalculationType, Context
from ..market_data import PortfolioData, load_portfolio_data, market_data
from ..models import PortfolioOutcome
from ..portfolio_results import portfolio_result, portfolio_rows
from ..returns import price_returns

logger = logging.getLogger(__name__)

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


def calculate_portfolio(params: Params, inputs: PortfolioData) -> pl.DataFrame:
    """Apply calculation-date weights to every historical return interval.

    Saved snapshots before/after the selected snapshot never change past
    exposures. Constant weights imply rebalancing each interval; this is a
    hypothetical series, rather than realized performance or buy-and-hold drift.
    """
    snapshot = inputs.holdings
    symbols = snapshot.symbols
    returns = price_returns(inputs.prices, symbols)
    if params.start_date is not None:
        returns = returns.filter(pl.col("date") >= params.start_date)
    if returns.is_empty():
        raise CalculationError(f"No shared return history up to {inputs.as_of}")
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
    """Load each portfolio's data, calculate directly and record its outcome."""
    if not ctx.portfolios:
        raise CalculationError(f"{NAME} needs at least one portfolio")
    frames, outcomes = [], []
    with market_data(ctx.as_of, ctx.load_symbol) as data:
        for index, portfolio in enumerate(ctx.portfolios):
            try:
                if params.start_date is not None and params.start_date > ctx.as_of:
                    raise CalculationError(
                        "start_date must be on or before the calculation date"
                    )
                inputs = load_portfolio_data(portfolio, data)
                rows = calculate_portfolio(params, inputs)
                rows = portfolio_rows(
                    rows,
                    OUTPUT,
                    portfolio.id,
                    index=index if ctx.mode == "batch" else None,
                )
            except Exception as error:
                logger.exception("%s failed for portfolio %s", NAME, portfolio.id)
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
    return portfolio_result(frames, outcomes, OUTPUT, indexed=ctx.mode == "batch")


# Registration depends on the params model and implementation above.
TYPE = CalculationType(
    name=NAME,
    description="Historical constant-weight returns of holdings selected at the calculation date.",
    params=Params,
    output=OUTPUT,
    run=run,
    takes_portfolio=True,
)
