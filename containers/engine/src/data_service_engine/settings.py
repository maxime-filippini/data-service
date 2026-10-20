from pydantic import AnyHttpUrl, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class EngineSettings(BaseSettings):
    """R2 access through the S3 API. Read from the environment or a local .env.

    The bucket name has no default so a dev deployment can never fall back to
    the production bucket.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
    )

    r2_endpoint_url: AnyHttpUrl
    r2_access_key_id: SecretStr = Field(min_length=1)
    r2_secret_access_key: SecretStr = Field(min_length=1)
    processed_bucket: str = Field(min_length=1)
