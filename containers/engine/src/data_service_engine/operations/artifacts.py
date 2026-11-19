"""Operation storage: R2 in the container, files locally.

Run artifacts use only IDs in the run namespace. A separate read-only method
resolves current published prices by validated symbol. Writing a run artifact
again replaces the same object, so a repeated call after a lost response is safe.
"""

import os
import re
import tempfile
from pathlib import Path
from typing import Literal, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from .contracts import ARTIFACT_ID_PATTERN, SYMBOL_PATTERN, Execution
from .errors import TerminalError, TransientError

_ARTIFACT_ID = re.compile(ARTIFACT_ID_PATTERN)
_SYMBOL = re.compile(SYMBOL_PATTERN)

PARQUET = "application/vnd.apache.parquet"


def run_artifact_id(
    execution: Execution, name: str, format: Literal["json", "parquet"]
) -> str:
    """The ID of a step's artifact, fixed by the run and step."""
    return f"runs/{execution.run_id}/{execution.step_id}/{name}.{format}"


def require_artifact_id(id: str) -> str:
    if not _ARTIFACT_ID.fullmatch(id):
        raise TerminalError(f"{id!r} is not a run artifact ID")
    return id


def _prices_key(symbol: str) -> str:
    if not _SYMBOL.fullmatch(symbol):
        raise TerminalError(f"{symbol!r} is not a valid asset symbol")
    return f"dataset=prices_eod/symbol={symbol}/data.parquet"


class ArtifactStore(Protocol):
    def read(self, id: str) -> bytes | None:
        """The artifact's bytes, or None when it does not exist."""
        ...

    def write(self, id: str, body: bytes, content_type: str) -> None:
        """Write or replace the artifact."""
        ...

    def read_published_prices(self, symbol: str) -> bytes | None:
        """Read current published prices for an asset from the processed store."""
        ...


class FileArtifactStore:
    """Artifacts as files under a directory shared with the Worker's local
    adapter: an ID maps to the same relative path. Writes go through a
    temporary file, so a reader never sees half an object."""

    def __init__(self, root: Path, processed_root: Path | None = None):
        self._root = root
        self._processed_root = processed_root

    def _path(self, id: str) -> Path:
        return self._root / require_artifact_id(id)

    def read(self, id: str) -> bytes | None:
        return self._read_path(self._path(id), "run artifact")

    def read_published_prices(self, symbol: str) -> bytes | None:
        if self._processed_root is None:
            raise TransientError("Set PROCESSED_ROOT to read local published prices")
        return self._read_path(
            self._processed_root / _prices_key(symbol), "published prices"
        )

    @staticmethod
    def _read_path(path: Path, description: str) -> bytes | None:
        try:
            return path.read_bytes()
        except FileNotFoundError:
            return None
        except OSError as error:
            raise TransientError(f"Could not read the {description}") from error

    def write(self, id: str, body: bytes, content_type: str) -> None:
        path = self._path(id)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
                file.write(body)
            os.replace(file.name, path)
        except OSError as error:
            raise TransientError(
                f"Could not write the run artifact: {error}"
            ) from error


def _is_missing(error: ClientError) -> bool:
    return error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}


class S3ArtifactStore:
    """Artifacts and published-price reads through the R2 S3 API."""

    def __init__(self, s3, bucket: str, processed_bucket: str | None = None):
        self._s3 = s3
        self._bucket = bucket
        self._processed_bucket = processed_bucket

    def read(self, id: str) -> bytes | None:
        return self._read_object(self._bucket, require_artifact_id(id), "run artifact")

    def read_published_prices(self, symbol: str) -> bytes | None:
        if self._processed_bucket is None:
            raise TransientError("Set PROCESSED_BUCKET to read published prices")
        return self._read_object(
            self._processed_bucket, _prices_key(symbol), "published prices"
        )

    def _read_object(self, bucket: str, key: str, description: str) -> bytes | None:
        try:
            result = self._s3.get_object(Bucket=bucket, Key=key)
            body = result["Body"]
            try:
                return body.read()
            finally:
                body.close()
        except ClientError as error:
            if _is_missing(error):
                return None
            raise TransientError(f"Could not read the {description}") from error
        except BotoCoreError as error:
            raise TransientError(f"Could not read the {description}") from error

    def write(self, id: str, body: bytes, content_type: str) -> None:
        key = require_artifact_id(id)
        try:
            self._s3.put_object(
                Bucket=self._bucket, Key=key, Body=body, ContentType=content_type
            )
        except (ClientError, BotoCoreError) as error:
            raise TransientError("Could not write the run artifact") from error
