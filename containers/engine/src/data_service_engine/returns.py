"""Aligned asset returns shared by hypothetical portfolio calculations."""

from collections.abc import Sequence

import polars as pl

from .errors import CalculationError


def price_returns(prices: pl.DataFrame, symbols: Sequence[str]) -> pl.DataFrame:
    """Simple adjusted-close returns between consecutive shared price dates.

    Accepts already-loaded symbol/date/adjusted_close rows and performs no I/O.
    Every held symbol must have a price at both ends of an interval. Missing
    dates are not filled: intervals may span gaps, so previous_date is explicit.
    Callers filtering output dates must retain a preceding price for the first
    return. Input date cutoffs belong to the data acquisition helper.
    """
    prices = prices.filter(pl.col("symbol").is_in(symbols)).pivot(
        on="symbol", index="date", values="adjusted_close"
    )
    missing = [symbol for symbol in symbols if symbol not in prices.columns]
    if missing:
        raise CalculationError(
            f"No prices in selected history for {', '.join(missing)}"
        )
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
