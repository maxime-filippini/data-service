"""R2 access through its S3 API, shared by calculations and operations."""

from contextlib import contextmanager

import boto3
from botocore.config import Config
from pydantic import AnyHttpUrl, SecretStr


@contextmanager
def r2_client(
    endpoint_url: AnyHttpUrl, access_key_id: SecretStr, secret_access_key: SecretStr
):
    """An S3 client for R2, closed on exit."""
    s3 = boto3.client(
        "s3",
        endpoint_url=str(endpoint_url),
        region_name="auto",
        aws_access_key_id=access_key_id.get_secret_value(),
        aws_secret_access_key=secret_access_key.get_secret_value(),
        config=Config(
            connect_timeout=10, read_timeout=120, retries={"max_attempts": 2}
        ),
    )
    try:
        yield s3
    finally:
        s3.close()
