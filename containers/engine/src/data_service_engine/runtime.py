"""Generic dispatch and optional result persistence.

Calculation implementations own data acquisition and execution shape. Neither
entry point interprets portfolio metadata or selects an iteration strategy.
"""

import logging

import polars as pl

from . import storage
from .errors import CalculationFailed, describe_error
from .framework import Context, get_type
from .models import CalculateRequest, RunRequest, RunResult

logger = logging.getLogger(__name__)


def run(request: RunRequest) -> RunResult:
    """Invoke a saved calculation once, then persist its successful result.

    Never raises: failures are reported for the Worker to record on the run.
    The selected type supplies its status and optional per-portfolio outcomes.
    """
    try:
        result = get_type(request.type).calculate(
            request.params, Context(request.as_of, request.portfolios, mode="saved")
        )
        if result.status == "failed":
            return RunResult(
                status="failed", error=result.error, portfolios=result.portfolios
            )
        settings = storage.load_settings()
        with storage.s3_client(settings) as s3:
            etag = storage.write_results(
                s3,
                settings.processed_bucket,
                request.output_key,
                request.as_of,
                result.rows,
            )
    except Exception as error:
        logger.exception("Run %s failed", request.run_id)
        return RunResult(status="failed", error=describe_error(error))
    return RunResult(
        status=result.status,
        error=result.error,
        portfolios=result.portfolios,
        row_count=result.rows.height,
        output_etag=etag,
    )


def calculate(request: CalculateRequest) -> pl.DataFrame:
    """Invoke an ad hoc calculation once and return its complete rows; no writes."""
    result = get_type(request.type).calculate(
        request.params,
        Context(request.as_of, request.selections, mode=request.mode),
    )
    if result.status != "completed":
        raise CalculationFailed(result.error or "Calculation did not complete")
    return result.rows
