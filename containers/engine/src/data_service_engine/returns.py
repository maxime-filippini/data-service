"""Aligned asset returns shared by hypothetical portfolio calculations."""

from collections.abc import Sequence
from datetime import date

import polars as pl

from .framework import CalculationError, Context


def price_returns(
    ctx: Context,
    symbols: Sequence[str],
    *,
    price_start: date | None = None,
) -> pl.DataFrame:
    """Simple adjusted-close returns between consecutive shared price dates.

    Every held symbol must have a price at both ends of an interval. Missing
    dates are not filled: intervals may span gaps, so previous_date is explicit.
    price_start restricts input prices, not returned observation dates. Callers
    filtering output dates must retain a preceding price for the first return.
    """
    prices = ctx.load("prices_eod", symbols, start=price_start).pivot(
        on="symbol", index="date", values="adjusted_close"
    )
    missing = [symbol for symbol in symbols if symbol not in prices.columns]
    if missing:
        period = f"since {price_start}" if price_start else f"up to {ctx.as_of}"
        raise CalculationError(f"No prices {period} for {', '.join(missing)}")
    return (
        prices.drop_nulls()
        .sort("date")
        .select(
            "date",
            pl.col("date").shift(1).alias("previous_date"),
            *(pl.col(symbol).pct_change() for symbol in symbols),
        )
        .slice(1)
    )
