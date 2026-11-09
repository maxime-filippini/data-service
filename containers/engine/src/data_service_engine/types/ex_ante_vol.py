"""Ex-ante volatility: the as-of date's weights applied to past daily returns."""

import logging
from datetime import timedelta

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

NAME = "ex_ante_vol"
OUTPUT = {
    "volatility": pl.Float64,
    "observations": pl.Int64,
    "window_start": pl.Date,
    "window_end": pl.Date,
    "holdings_date": pl.Date,
}


class Params(BaseModel):
    """Type-specific inputs for ex-ante volatility, used by validation and run().

    The window counts aligned return observations; annualisation scales the
    variance. Decay selects EWMA instead of sample variance, and weight
    normalization is optional. This model also supplies editor schema/defaults.
    """

    model_config = ConfigDict(extra="forbid")

    window: int = Field(252, ge=2, description="Number of daily returns to use.")
    annualisation: float = Field(
        252, gt=0, description="Periods per year; the variance is scaled by it."
    )
    decay: float | None = Field(
        None,
        gt=0,
        lt=1,
        description=(
            "EWMA decay factor (e.g. 0.94), with a zero mean as in RiskMetrics. "
            "Leave empty for an equally weighted sample standard deviation."
        ),
    )
    normalise_weights: bool = Field(
        False, description="Divide the weights by their sum before calculating."
    )


def calculate_portfolio(params: Params, inputs: PortfolioData) -> pl.DataFrame:
    """Apply as-of holdings to aligned returns and estimate annualized volatility."""

    snapshot = inputs.holdings
    symbols = snapshot.symbols
    weights = np.array([snapshot.weights[symbol] for symbol in symbols])

    if params.normalise_weights:
        total = weights.sum()
        if np.isclose(total, 0):
            raise CalculationError("Weights sum to zero, so they can't be normalised")
        weights = weights / total

    returns = price_returns(inputs.prices, symbols).tail(params.window)
    if returns.height < params.window:
        raise CalculationError(
            f"Only {returns.height} daily returns up to {inputs.as_of}, need {params.window}"
        )
    matrix = returns.select(symbols).to_numpy()
    if not np.isfinite(matrix).all():
        raise CalculationError("Prices include zeros, so returns are infinite")
    portfolio_returns = matrix @ weights

    if params.decay is None:
        variance = portfolio_returns.var(ddof=1)
    else:
        age = np.arange(len(portfolio_returns) - 1, -1, -1)
        decay_weights = params.decay**age
        variance = (decay_weights * portfolio_returns**2).sum() / decay_weights.sum()

    dates = returns["date"]
    return pl.DataFrame(
        {
            "volatility": [float(np.sqrt(variance * params.annualisation))],
            "observations": [returns.height],
            "window_start": [dates.first()],
            "window_end": [dates.last()],
            "holdings_date": [snapshot.holdings_date],
        },
        schema=OUTPUT,
    )


def run(params: Params, ctx: Context) -> CalculationResult:
    """Load each portfolio's data, calculate directly and record its outcome."""
    if not ctx.portfolios:
        raise CalculationError(f"{NAME} needs at least one portfolio")
    start = ctx.as_of - timedelta(days=params.window * 2 + 30)
    frames, outcomes = [], []
    with market_data(ctx.as_of, ctx.load_symbol) as data:
        for index, portfolio in enumerate(ctx.portfolios):
            try:
                inputs = load_portfolio_data(portfolio, data, start=start)
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


# Registration needs the params model and run function defined above.
TYPE = CalculationType(
    name=NAME,
    description=(
        "Annualised volatility of the weights held at the as-of date over past "
        "daily returns of adjusted close prices."
    ),
    params=Params,
    output=OUTPUT,
    run=run,
    takes_portfolio=True,
)
