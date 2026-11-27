"""Ex-ante volatility: the processing date's weights applied to past daily returns."""

from collections.abc import Callable, Mapping, Sequence
from datetime import date, timedelta

import numpy as np
import polars as pl
from pydantic import BaseModel, ConfigDict, Field

from ..errors import CalculationError

OUTPUT = {
    "volatility": pl.Float64,
    "observations": pl.Int64,
    "window_start": pl.Date,
    "window_end": pl.Date,
    "holdings_date": pl.Date,
}

# Loads the full `(dataset, symbol)` prices DataFrame (`date`, `adjusted_close`).
SymbolLoader = Callable[[str, str], pl.DataFrame]


class Params(BaseModel):
    """Numerical parameters for ex-ante volatility.

    The window counts aligned return observations; annualisation scales the
    variance. Decay selects EWMA instead of sample variance, and weight
    normalization is optional.
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


def _load_prices(
    load_symbol: SymbolLoader,
    as_of: date,
    symbols: Sequence[str],
    start: date,
) -> pl.DataFrame:
    dfs = []
    for symbol in dict.fromkeys(symbols):
        df = load_symbol("prices_eod", symbol).filter(
            (pl.col("date") >= start) & (pl.col("date") <= as_of)
        )
        dfs.append(df.select(pl.lit(symbol).alias("symbol"), pl.all()))
    if not dfs:
        raise ValueError("Load at least one symbol")
    return pl.concat(dfs).sort("symbol", "date")


def daily_returns(
    load_symbol: SymbolLoader,
    as_of: date,
    symbols: Sequence[str],
    window: int,
) -> pl.DataFrame:
    """The last `window` simple returns on dates every symbol has a price."""
    # Calendar days that comfortably hold `window` trading days.
    start = as_of - timedelta(days=window * 2 + 30)
    prices = _load_prices(load_symbol, as_of, symbols, start).pivot(
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
            f"Only {returns.height} daily returns up to {as_of}, need {window}"
        )
    return returns


def run(
    params: Params,
    *,
    as_of: date,
    holdings_date: date,
    holdings: Mapping[str, float],
    load_symbol: SymbolLoader,
) -> pl.DataFrame:
    """Compute ex-ante volatility for one effective holdings snapshot."""
    if not holdings:
        raise CalculationError("At least one holding is required")
    symbols = list(holdings.keys())
    weights = np.array([holdings[symbol] for symbol in symbols], dtype=float)

    if params.normalise_weights:
        total = weights.sum()
        if np.isclose(total, 0):
            raise CalculationError("Weights sum to zero, so they can't be normalised")
        weights = weights / total

    returns = daily_returns(load_symbol, as_of, symbols, params.window)
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
            "holdings_date": [holdings_date],
        },
        schema=OUTPUT,
    )
