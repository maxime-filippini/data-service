"""The operation registry and the uniform dispatcher behind
`POST /operations/{name}`."""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from .artifacts import ArtifactStore
from .contracts import (
    Contract,
    ErrorResponse,
    Issue,
    OperationFailure,
    OperationRequest,
)
from .errors import OperationError

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Operation:
    """One registered operation: its name, request model (narrowing `inputs`
    and `params`), response model and implementation. The implementation
    raises `TransientError` or `TerminalError` for expected failures."""

    name: str
    description: str
    request: type[OperationRequest]
    response: type[Contract]
    run: Callable[[Any, ArtifactStore], Contract]

    def describe(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "request": self.request.model_json_schema(),
            "response": self.response.model_json_schema(),
        }


def operations() -> dict[str, Operation]:
    """Every operation, by name. Registrations are explicit."""
    from . import normalize_prices, portfolio_volatility

    registered = [normalize_prices.OPERATION, portfolio_volatility.OPERATION]
    by_name = {operation.name: operation for operation in registered}
    if len(by_name) != len(registered):
        raise RuntimeError("Two operations share a name")
    return by_name


@dataclass(frozen=True)
class Outcome:
    """An HTTP status and JSON body."""

    status: int
    body: dict


def failure(
    status: int, kind: str, message: str, issues: list[Issue] | None = None
) -> Outcome:
    error = ErrorResponse(
        error=OperationFailure(kind=kind, message=message, issues=issues or [])
    )
    return Outcome(status, error.model_dump(mode="json"))


def _issues(error: ValidationError) -> list[Issue]:
    return [
        Issue(path=[str(part) for part in issue["loc"]], message=issue["msg"])
        for issue in error.errors(include_url=False)
    ]


def dispatch(name: str, body: bytes, artifacts: Callable[[], Any]) -> Outcome:
    """Validate a request, run the operation and validate its response.

    `artifacts` opens the artifact store (a context manager) only once the
    request is valid. Status codes: 200 success; 404 unknown operation and
    422 invalid request or terminal failure (both `terminal`); 503 transient
    failure; 500 unexpected error (reported `transient`: it may be an outage
    as much as a bug, and the caller's retries are bounded).
    """
    operation = operations().get(name)
    if operation is None:
        return failure(404, "terminal", f"Unknown operation {name!r}")
    try:
        request = operation.request.model_validate_json(body)
    except ValidationError as error:
        return failure(422, "terminal", "Invalid operation request", _issues(error))
    try:
        with artifacts() as store:
            produced = operation.run(request, store)
        response = operation.response.model_validate(produced.model_dump())
    except OperationError as error:
        status = 503 if error.kind == "transient" else 422
        return failure(status, error.kind, error.message)
    except Exception as error:
        logger.exception("Operation %s failed", name)
        return failure(500, "transient", f"{type(error).__name__}: {error}"[:500])
    return Outcome(200, response.model_dump(mode="json"))
