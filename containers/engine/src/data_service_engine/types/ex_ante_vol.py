"""Ex-ante volatility: the as-of date's weights applied to past daily returns."""

from datetime import timedelta

import numpy as np
import polars as pl
from pydantic import BaseModel, ConfigDict, Field

from ..framework import CalculationError, CalculationType, Context


class Params(BaseModel):
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


OUTPUT = {
    "volatility": pl.Float64,
    "observations": pl.Int64,
    "window_start": pl.Date,
    "window_end": pl.Date,
    "holdings_date": pl.Date,
}


def daily_returns(ctx: Context, symbols: list[str], window: int) -> pl.DataFrame:
    """The last `window` simple returns on dates every symbol has a price."""
    # Calendar days that comfortably hold `window` trading days.
    start = ctx.as_of - timedelta(days=window * 2 + 30)
    prices = ctx.load("prices_eod", symbols, start=start).pivot(
        on="symbol", index="date", values="adjusted_close"
    )
    missing = [symbol for symbol in symbols if symbol not in prices.columns]
    if missing:
        raise CalculationError(f"No prices since {start} for {', '.join(missing)}")
    returns = (
        prices.drop_nulls()
        .sort("date")
        .select("date", *(pl.col(symbol).pct_change() for symbol in symbols))
        .slice(1)
        .tail(window)
    )
    if returns.height < window:
        raise CalculationError(
            f"Only {returns.height} daily returns up to {ctx.as_of}, need {window}"
        )
    return returns


def run(params: Params, ctx: Context) -> pl.DataFrame:
    assert ctx.portfolio is not None

    snapshot = ctx.portfolio.holdings_at(ctx.as_of)
    symbols = snapshot.symbols
    weights = np.array([snapshot.weights[symbol] for symbol in symbols])

    if params.normalise_weights:
        total = weights.sum()
        if np.isclose(total, 0):
            raise CalculationError("Weights sum to zero, so they can't be normalised")
        weights = weights / total

    returns = daily_returns(ctx, symbols, params.window)
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


TYPE = CalculationType(
    name="ex_ante_vol",
    description=(
        "Annualised volatility of the weights held at the as-of date over past "
        "daily returns of adjusted close prices."
    ),
    params=Params,
    output=OUTPUT,
    run=run,
    takes_portfolio=True,
)
