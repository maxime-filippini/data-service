"""Read-only access to published datasets for operations.

Kept apart from the run artifact store, which never sees a published path:
an operation that consumes published data is given this reader as well.
Keys are built from a validated symbol, so a caller cannot reach any other
object.
"""

import re
from pathlib import Path
from typing import Protocol

from .artifacts import read_file, read_object
from .contracts import SYMBOL_PATTERN
from .errors import TerminalError, TransientError

_SYMBOL = re.compile(SYMBOL_PATTERN)


def prices_key(symbol: str) -> str:
    if not _SYMBOL.fullmatch(symbol):
        raise TerminalError(f"{symbol!r} is not a valid asset symbol")
    return f"dataset=prices_eod/symbol={symbol}/data.parquet"


class PublishedPrices(Protocol):
    def read(self, symbol: str) -> bytes | None:
        """An asset's current published `prices_eod` Parquet, or None."""
        ...


class FilePublishedPrices:
    """Published prices as files under the local processed directory."""

    def __init__(self, root: Path):
        self._root = root

    def read(self, symbol: str) -> bytes | None:
        return read_file(self._root / prices_key(symbol), "published prices")


class S3PublishedPrices:
    """Published prices in the processed R2 bucket."""

    def __init__(self, s3, bucket: str):
        self._s3 = s3
        self._bucket = bucket

    def read(self, symbol: str) -> bytes | None:
        return read_object(
            s3=self._s3,
            bucket=self._bucket,
            key=prices_key(symbol),
            description="published prices",
        )


class UnconfiguredPublishedPrices:
    """Stands in when no processed store is configured, so operations that
    never read published data still run; a read names the missing setting."""

    def __init__(self, setting: str):
        self._setting = setting

    def read(self, symbol: str) -> bytes | None:
        raise TransientError(f"Set {self._setting} to read published prices")
