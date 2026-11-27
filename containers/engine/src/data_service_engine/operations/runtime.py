from contextlib import contextmanager

from ..r2 import r2_client
from ..settings import OperationSettings
from .artifacts import FileArtifactStore, S3ArtifactStore
from .published import (
    FilePublishedPrices,
    S3PublishedPrices,
    UnconfiguredPublishedPrices,
)
from .registry import OperationStorage


def load_settings() -> OperationSettings:
    return OperationSettings()  # pyright: ignore[reportCallIssue]


@contextmanager
def operation_storage(settings: OperationSettings | None = None):
    """Open the configured local or R2 operation storage."""
    settings = settings if settings is not None else load_settings()
    if settings.artifact_root is not None:
        yield OperationStorage(
            artifacts=FileArtifactStore(settings.artifact_root),
            published_prices=(
                UnconfiguredPublishedPrices("PROCESSED_ROOT")
                if settings.processed_root is None
                else FilePublishedPrices(settings.processed_root)
            ),
        )
        return
    assert settings.r2_endpoint_url is not None
    assert settings.r2_access_key_id is not None
    assert settings.r2_secret_access_key is not None
    assert settings.artifact_bucket is not None
    with r2_client(
        settings.r2_endpoint_url,
        settings.r2_access_key_id,
        settings.r2_secret_access_key,
    ) as s3:
        yield OperationStorage(
            artifacts=S3ArtifactStore(s3, settings.artifact_bucket),
            published_prices=(
                UnconfiguredPublishedPrices("PROCESSED_BUCKET")
                if settings.processed_bucket is None
                else S3PublishedPrices(s3, settings.processed_bucket)
            ),
        )
