"""HTTP API. Only the Worker calls it, so there is no auth."""

import io
import logging

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import ValidationError

from . import runtime
from .framework import (
    CalculationError,
    CalculationType,
    UnknownTypeError,
    describe_error,
    get_type,
    registry,
)
from .models import CalculateRequest, RunRequest, ValidateRequest

logger = logging.getLogger(__name__)
app = FastAPI()

ARROW_STREAM = "application/vnd.apache.arrow.stream"


def _type_or_404(name: str) -> CalculationType:
    try:
        return get_type(name)
    except UnknownTypeError as error:
        raise HTTPException(404, str(error)) from error


def _params_errors(error: ValidationError):
    return error.errors(include_url=False, include_context=False, include_input=False)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/types")
def list_types():
    return [calculation_type.describe() for calculation_type in registry().values()]


@app.post("/types/{name}/validate")
def validate_params(name: str, body: ValidateRequest):
    """Check params for a type. Returns them with defaults filled in."""
    calculation_type = _type_or_404(name)
    try:
        params = calculation_type.validate_params(body.params)
    except ValidationError as error:
        raise HTTPException(422, _params_errors(error)) from error
    return {"params": params.model_dump(mode="json")}


@app.post("/runs")
def run_calculation(request: RunRequest):
    """Run a saved calculation for one as-of date and write its rows to R2.

    Always 200 for a well-formed request; the body says whether the run
    completed, partly completed or failed.
    """
    return runtime.run(request).model_dump(mode="json", by_alias=True)


@app.post("/calculate")
def calculate(request: CalculateRequest, http_request: Request):
    """Run an ad hoc calculation and return its rows, as JSON or Arrow."""
    calculation_type = _type_or_404(request.type)
    try:
        calculation_type.validate_params(request.params)
    except ValidationError as error:
        raise HTTPException(422, _params_errors(error)) from error
    try:
        rows = runtime.calculate(request)
    except CalculationError as error:
        raise HTTPException(422, str(error)) from error
    except runtime.CalculationFailed as error:
        raise HTTPException(500, str(error)) from error
    except Exception as error:
        logger.exception("Ad hoc %s failed", request.type)
        raise HTTPException(500, describe_error(error)) from error

    if ARROW_STREAM in http_request.headers.get("accept", ""):
        output = io.BytesIO()
        rows.write_ipc_stream(output)
        return Response(output.getvalue(), media_type=ARROW_STREAM)
    # Polars writes NaN and infinity as null, which plain JSON can't hold.
    return Response('{"rows":' + rows.write_json() + "}", media_type="application/json")
