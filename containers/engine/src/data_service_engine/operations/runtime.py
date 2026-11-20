from contextlib import contextmanager

from ..r2 import r2_client
from ..settings import OperationSettings
from .artifacts import FileArtifactStore, S3ArtifactStore


def load_settings() -> OperationSettings:
    return OperationSettings()  # pyright: ignore[reportCallIssue]


@contextmanager
def artifact_store(settings: OperationSettings | None = None):
    """The run artifact store the settings select: local files under
    `ARTIFACT_ROOT`, or the R2 artifact bucket."""
    settings = settings if settings is not None else load_settings()
    if settings.artifact_root is not None:
        yield FileArtifactStore(settings.artifact_root)
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
        yield S3ArtifactStore(s3, settings.artifact_bucket)
