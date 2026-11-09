from datetime import date

import pytest

from data_service_engine import storage
from data_service_engine.market_data import MarketData, market_data

from .conftest import prices_df, prices_key

AS_OF = date(2026, 10, 16)


def test_injected_loader_needs_no_settings_or_connection(monkeypatch):
    def unavailable():
        raise AssertionError("credentials should not be needed")

    monkeypatch.setattr(storage, "load_settings", unavailable)
    reads = []

    def load(dataset, symbol):
        reads.append((dataset, symbol))
        return prices_df([1, 2])

    with market_data(AS_OF, load) as data:
        assert reads == []
        assert data.load("prices_eod", ["A"]).height == 2
    assert reads == [("prices_eod", "A")]


def test_data_scope_is_lazy_caches_objects_and_closes_on_failure(
    environment, monkeypatch, r2
):
    r2.put_df(prices_key("A"), prices_df([1, 2]))
    events = []

    class Client:
        def __init__(self, settings):
            pass

        def __enter__(self):
            events.append("opened")
            return r2

        def __exit__(self, *args):
            events.append("closed")

    monkeypatch.setattr(storage, "s3_client", Client)
    assert events == []
    with (
        pytest.raises(RuntimeError, match="failed calculation"),
        market_data(AS_OF) as data,
    ):
        assert r2.reads == []
        data.load("prices_eod", ["A"])
        data.load("prices_eod", ["A"], start=AS_OF)
        assert r2.reads == [prices_key("A")]
        raise RuntimeError("failed calculation")
    assert events == ["opened", "closed"]


def test_market_data_load_never_returns_rows_after_as_of():
    dfs = {
        "A": prices_df([1, 2, 3, 4], end=date(2026, 10, 16)),
        "B": prices_df([5, 6], end=date(2026, 10, 16)),
    }
    loaded = []

    def load(dataset, symbol):
        loaded.append((dataset, symbol))
        return dfs[symbol]

    data = MarketData(date(2026, 10, 15), load)
    df = data.load("prices_eod", ["B", "A", "B"], start=date(2026, 10, 13))
    assert df.columns[0] == "symbol"
    assert df.select("symbol", "date", "close").rows() == [
        ("A", date(2026, 10, 13), 1.0),
        ("A", date(2026, 10, 14), 2.0),
        ("A", date(2026, 10, 15), 3.0),
        ("B", date(2026, 10, 15), 5.0),
    ]
    assert loaded == [("prices_eod", "B"), ("prices_eod", "A")]
    # An explicit end after as_of is clamped too.
    assert data.load("prices_eod", ["A"], end=date(2027, 1, 1))["date"].max() == (
        date(2026, 10, 15)
    )
