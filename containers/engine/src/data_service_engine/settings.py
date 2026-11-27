from pathlib import Path
from typing import Self

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_CONFIG = SettingsConfigDict(
    env_file=".env",
    env_file_encoding="utf-8",
    extra="ignore",
    hide_input_in_errors=True,
)


class OperationSettings(BaseSettings):
    """Where workflow operations access run artifacts and published prices.

    Locally, `ARTIFACT_ROOT` names a directory shared with the TypeScript
    side: an artifact ID maps to the same relative path under it. In the
    container, artifacts live in R2 (`ARTIFACT_BUCKET`, the raw bucket that
    holds the `runs/` namespace) and the R2 credentials are required. There
    is no default bucket, so a dev deployment never touches production data.
    `PROCESSED_ROOT` (local) or `PROCESSED_BUCKET` (R2) supplies published
    prices for operations that consume them.
    """

    model_config = _CONFIG

    artifact_root: Path | None = None
    artifact_bucket: str | None = Field(None, min_length=1)
    processed_root: Path | None = None
    processed_bucket: str | None = Field(None, min_length=1)
    r2_endpoint_url: AnyHttpUrl | None = None
    r2_access_key_id: SecretStr | None = Field(None, min_length=1)
    r2_secret_access_key: SecretStr | None = Field(None, min_length=1)

    @model_validator(mode="after")
    def _one_storage(self) -> Self:
        if self.artifact_root is not None:
            return self
        missing = [
            name.upper()
            for name in (
                "artifact_bucket",
                "r2_endpoint_url",
                "r2_access_key_id",
                "r2_secret_access_key",
            )
            if getattr(self, name) is None
        ]
        if missing:
            raise ValueError(
                "Set ARTIFACT_ROOT for local files, or R2 storage: missing "
                + ", ".join(missing)
            )
        return self
