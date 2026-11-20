"""Run artifact storage for operations: R2 in the container, files locally.

Only IDs in the run namespace (`runs/<runId>/<stepId>/<name>.<ext>`) reach
a store, so an operation can never read or write an arbitrary path or a
published dataset. Writing an ID again replaces the object, which makes a
repeated call after a lost response safe.
"""

import os
import re
import tempfile
from pathlib import Path
from typing import Literal, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from .contracts import ARTIFACT_ID_PATTERN, Execution
from .errors import TerminalError, TransientError

_ARTIFACT_ID = re.compile(ARTIFACT_ID_PATTERN)

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


class ArtifactStore(Protocol):
    def read(self, id: str) -> bytes | None:
        """The artifact's bytes, or None when it does not exist."""
        ...

    def write(self, id: str, body: bytes, content_type: str) -> None:
        """Write or replace the artifact."""
        ...


class FileArtifactStore:
    """Artifacts as files under a directory shared with the Worker's local
    adapter: an ID maps to the same relative path. Writes go through a
    temporary file, so a reader never sees half an object."""

    def __init__(self, root: Path):
        self._root = root

    def _path(self, id: str) -> Path:
        return self._root / require_artifact_id(id)

    def read(self, id: str) -> bytes | None:
        try:
            return self._path(id).read_bytes()
        except FileNotFoundError:
            return None
        except OSError as error:
            raise TransientError(f"Could not read the run artifact: {error}") from error

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
    """Artifacts in an R2 bucket through the S3 API, under `runs/`."""

    def __init__(self, s3, bucket: str):
        self._s3 = s3
        self._bucket = bucket

    def read(self, id: str) -> bytes | None:
        key = require_artifact_id(id)
        try:
            result = self._s3.get_object(Bucket=self._bucket, Key=key)
        except ClientError as error:
            if _is_missing(error):
                return None
            raise TransientError("Could not read the run artifact") from error
        except BotoCoreError as error:
            raise TransientError("Could not read the run artifact") from error
        body = result["Body"]
        try:
            return body.read()
        finally:
            body.close()

    def write(self, id: str, body: bytes, content_type: str) -> None:
        key = require_artifact_id(id)
        try:
            self._s3.put_object(
                Bucket=self._bucket, Key=key, Body=body, ContentType=content_type
            )
        except (ClientError, BotoCoreError) as error:
            raise TransientError("Could not write the run artifact") from error
