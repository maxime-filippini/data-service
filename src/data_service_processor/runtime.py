from contextlib import contextmanager

import boto3
from botocore.config import Config

from .models import Manifest
from .processor import process
from .settings import ProcessorSettings


def load_settings() -> ProcessorSettings:
    return ProcessorSettings()  # pyright: ignore[reportCallIssue]


def run(manifest: Manifest) -> str:
    """Process one manifest with settings from the environment."""
    settings = load_settings()
    with s3_client(settings) as s3:
        return process(
            s3,
            manifest,
            raw_bucket=settings.raw_bucket,
            processed_bucket=settings.processed_bucket,
        )


@contextmanager
def s3_client(settings: ProcessorSettings | None = None):
    settings = settings if settings is not None else load_settings()
    s3 = boto3.client(
        "s3",
        endpoint_url=str(settings.r2_endpoint_url),
        region_name="auto",
        aws_access_key_id=settings.r2_access_key_id.get_secret_value(),
        aws_secret_access_key=settings.r2_secret_access_key.get_secret_value(),
        config=Config(
            connect_timeout=10, read_timeout=120, retries={"max_attempts": 2}
        ),
    )
    try:
        yield s3
    finally:
        s3.close()
