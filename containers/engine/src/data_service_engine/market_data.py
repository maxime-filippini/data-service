"""Opt-in canonical data access for any calculation shape.

Open market_data() inside the calculation that needs it. One scope shares a
lazy symbol cache across all reads, and closes its storage connection on exit.
"""

from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date

import polars as pl

from . import storage
from .models import Portfolio, Snapshot

# Reads a complete canonical (dataset, symbol) object or raises MissingDataError.
SymbolLoader = Callable[[str, str], pl.DataFrame]


@dataclass(frozen=True)
class PortfolioData:
    """Calculation-date holdings and canonical prices prepared for computation.

    holdings is the snapshot effective at as_of. prices contains symbol/date
    rows for exactly those holdings, with dates bounded by the requested range
    and as_of. Exposures are unchanged, including negative/non-unit weights.
    This value owns no connection and can be passed to ordinary pure functions.
    """

    as_of: date
    holdings: Snapshot
    prices: pl.DataFrame


@dataclass(frozen=True)
class MarketData:
    """Date-bounded dataset reader, independent of portfolios and result shape.

    load() returns a symbol column plus dataset columns, ordered by symbol/date.
    Bounds are inclusive and end is always clamped to as_of. Injecting a loader
    lets the same interface work with local frames in numerical tests.
    """

    as_of: date
    _load_symbol: SymbolLoader = field(repr=False)

    def load(
        self,
        dataset: str,
        symbols: Sequence[str],
        start: date | None = None,
        end: date | None = None,
    ) -> pl.DataFrame:
        end = self.as_of if end is None else min(end, self.as_of)
        frames = []
        for symbol in dict.fromkeys(symbols):
            frame = self._load_symbol(dataset, symbol).filter(pl.col("date") <= end)
            if start is not None:
                frame = frame.filter(pl.col("date") >= start)
            frames.append(frame.select(pl.lit(symbol).alias("symbol"), pl.all()))
        if not frames:
            raise ValueError("Load at least one symbol")
        return pl.concat(frames).sort("symbol", "date")


@contextmanager
def market_data(
    as_of: date, load_symbol: SymbolLoader | None = None
) -> Iterator[MarketData]:
    """Acquire a request-scoped reader only when the calculation calls it.

    Production reads canonical Parquet from the configured bucket and caches
    each symbol object for this scope. An injected loader avoids credentials and
    storage connections entirely. No result writes occur through this helper.
    """
    if load_symbol is not None:
        yield MarketData(as_of, load_symbol)
        return
    settings = storage.load_settings()
    with storage.s3_client(settings) as s3:
        yield MarketData(as_of, storage.SymbolReader(s3, settings.processed_bucket))


def load_portfolio_data(
    portfolio: Portfolio,
    data: MarketData,
    *,
    start: date | None = None,
) -> PortfolioData:
    """Resolve as-of holdings and load their adjusted-price source rows.

    portfolio is a resolved saved history or inline composition. The Worker
    resolves saved IDs through D1 before calling Python. No future holdings or
    prices are used. The caller chooses history bounds and performs the actual
    calculation after this function returns; no callback or iteration is owned
    here. Shared data scopes reuse symbol reads across calls.
    """
    holdings = portfolio.holdings_at(data.as_of)
    prices = data.load("prices_eod", holdings.symbols, start=start)
    return PortfolioData(data.as_of, holdings, prices)
