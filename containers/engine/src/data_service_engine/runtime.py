import logging
from contextlib import contextmanager

import boto3
import polars as pl
from botocore.config import Config

from .framework import describe_error, get_type
from .models import CalculateRequest, RunRequest, RunResult
from .settings import EngineSettings
from .storage import SymbolReader, write_results

logger = logging.getLogger(__name__)


class CalculationFailed(Exception):
    """An ad hoc calculation ran but failed. The message says why."""


def load_settings() -> EngineSettings:
    return EngineSettings()  # pyright: ignore[reportCallIssue]


@contextmanager
def s3_client(settings: EngineSettings | None = None):
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


def run(request: RunRequest) -> RunResult:
    """Run a saved calculation and write its rows for the as-of date.

    Never raises: anything that goes wrong is reported in the result, for the
    Worker to record on the run.
    """
    try:
        calculation_type = get_type(request.type)
        settings = load_settings()
        with s3_client(settings) as s3:
            bucket = settings.processed_bucket
            rows, outcomes = calculation_type.calculate(
                request.params,
                request.as_of,
                request.portfolios,
                SymbolReader(s3, bucket),
            )
            failed = [o for o in outcomes if o.status == "failed"]
            if len(failed) == len(outcomes):
                error = (
                    failed[0].error
                    if len(failed) == 1
                    else f"All {len(failed)} portfolios failed"
                )
                return RunResult(status="failed", error=error, portfolios=outcomes)
            etag = write_results(s3, bucket, request.output_key, request.as_of, rows)
    except Exception as error:
        logger.exception("Run %s failed", request.run_id)
        return RunResult(status="failed", error=describe_error(error))
    return RunResult(
        status="partial" if failed else "completed",
        portfolios=outcomes,
        row_count=rows.height,
        output_etag=etag,
    )


def calculate(request: CalculateRequest) -> pl.DataFrame:
    """Run an ad hoc calculation and return its rows. Nothing is written.

    The caller checks the type and params first. Raises CalculationError for
    the wrong number of portfolios and CalculationFailed when the calculation
    itself fails.
    """
    calculation_type = get_type(request.type)
    portfolios = [request.portfolio] if request.portfolio else []
    settings = load_settings()
    with s3_client(settings) as s3:
        rows, outcomes = calculation_type.calculate(
            request.params,
            request.as_of,
            portfolios,
            SymbolReader(s3, settings.processed_bucket),
        )
    if outcomes[0].status == "failed":
        raise CalculationFailed(outcomes[0].error)
    return rows
