from datetime import date

import polars as pl
import pytest
from botocore.exceptions import ClientError

from data_service_engine.framework import MissingDataError
from data_service_engine.storage import SymbolReader, write_results

from .conftest import BUCKET, prices_df, prices_key

KEY = "calculation=calc-1/data.parquet"
DAY_1, DAY_2 = date(2026, 10, 15), date(2026, 10, 16)


def rows(as_of, *values, **extra):
    return pl.DataFrame(
        {
            "as_of": [as_of] * len(values),
            "portfolio_id": [f"p{i}" for i in range(len(values))],
            "value": list(values),
            **{name: [v] * len(values) for name, v in extra.items()},
        },
        schema_overrides={"as_of": pl.Date},
    )


def test_symbol_reader_reads_each_object_once(r2):
    r2.put_df(prices_key("AAPL.US"), prices_df([1, 2]))
    reader = SymbolReader(r2, BUCKET)
    assert reader("prices_eod", "AAPL.US").height == 2
    assert reader("prices_eod", "AAPL.US").height == 2
    assert r2.reads == [prices_key("AAPL.US")]

    with pytest.raises(MissingDataError, match="No prices_eod data for MSFT.US"):
        reader("prices_eod", "MSFT.US")
    for dataset, symbol in [("../x", "A"), ("prices_eod", "a/b"), ("prices_eod", "")]:
        with pytest.raises(ValueError):
            reader(dataset, symbol)


def test_first_write_creates_the_object_only_if_absent(r2):
    write_results(r2, BUCKET, KEY, DAY_1, rows(DAY_1, 1.0))
    assert r2.writes[-1]["IfNoneMatch"] == "*"
    assert r2.read_df(KEY)["value"].to_list() == [1.0]


def test_rerunning_a_date_replaces_only_that_dates_rows(r2):
    write_results(r2, BUCKET, KEY, DAY_2, rows(DAY_2, 2.0, 3.0))
    write_results(r2, BUCKET, KEY, DAY_1, rows(DAY_1, 1.0))
    etag = write_results(r2, BUCKET, KEY, DAY_2, rows(DAY_2, 4.0))

    df = r2.read_df(KEY)
    assert df.select("as_of", "portfolio_id", "value").rows() == [
        (DAY_1, "p0", 1.0),
        (DAY_2, "p0", 4.0),
    ]
    assert r2.objects[BUCKET, KEY][1] == etag


def test_write_is_conditional_on_the_object_read(r2):
    write_results(r2, BUCKET, KEY, DAY_1, rows(DAY_1, 1.0))
    original_get = r2.get_object

    def get_then_change(**kwargs):
        result = original_get(**kwargs)
        r2.put(KEY, r2.objects[BUCKET, KEY][0])  # someone else writes meanwhile
        return result

    r2.get_object = get_then_change
    with pytest.raises(ClientError):
        write_results(r2, BUCKET, KEY, DAY_2, rows(DAY_2, 2.0))


def test_new_output_columns_are_added_with_nulls_for_old_rows(r2):
    write_results(r2, BUCKET, KEY, DAY_1, rows(DAY_1, 1.0))
    write_results(r2, BUCKET, KEY, DAY_2, rows(DAY_2, 2.0, extra=7))
    df = r2.read_df(KEY)
    assert df.columns == ["as_of", "portfolio_id", "value", "extra"]
    assert df["extra"].to_list() == [None, 7]
