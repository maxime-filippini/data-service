"""Pydantic models covering the field shapes operation contracts may use, for
testing the TypeScript contract generator against real Pydantic output.
`fixtures/operation-contracts/shapes.json` is their export (checked by
`test_contract_shapes.py`); regenerate it from containers/engine with:

    uv run python -m tests.contract_shapes > ../../fixtures/operation-contracts/shapes.json

With `--validate`, it reads `[{"model": ..., "value": ...}]` on stdin and
prints whether Pydantic accepts each value, so the TypeScript tests can check
that the generated schemas are never more lenient than the models.
"""

import json
import sys
from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, ValidationError

from data_service_engine.operations.contracts import Contract, ErrorResponse


class Frequency(StrEnum):
    DAILY = "daily"
    WEEKLY = "weekly"


class Window(Contract):
    """A nested model, shared by both operations."""

    start: date
    end: date


class Fixed(Contract):
    kind: Literal["fixed"]
    weight: Annotated[float, Field(gt=0, le=1)]


class Equal(Contract):
    kind: Literal["equal"]


class ShapesRequest(Contract):
    """Every scalar and container shape, with camelCase aliases."""

    required_text: Annotated[str, Field(min_length=1, max_length=8)]
    optional_text: str | None = None
    nullable_count: int | None
    count: Annotated[int, Field(ge=0, le=10)]
    ratio: float
    enabled: bool = True
    frequency: Frequency
    mode: Literal["fast", "slow"]
    version: Literal["v1"]
    day: date
    at: datetime
    path: Annotated[str, Field(pattern=r"^runs/[a-z]+/[a-z]+\.json$")]
    tags: list[str]
    windows: list[Window]
    weights: dict[str, float]
    pair: tuple[str, int]
    scheme: Annotated[Fixed | Equal, Field(discriminator="kind")]


class ShapesResponse(Contract):
    window: Window
    maybe_window: Window | None = None


class EmptyParams(Contract):
    """No parameters."""


class OtherRequest(Contract):
    window: Window
    params: EmptyParams


class OtherResponse(Contract):
    total: int


def export_shapes() -> dict:
    """The same document shape as `export_schemas()`."""
    return {
        "operations": {
            "check-shapes": {
                "description": "Every field shape",
                "request": ShapesRequest.model_json_schema(),
                "response": ShapesResponse.model_json_schema(),
            },
            "other-operation": {
                "description": "Shares a model with check-shapes",
                "request": OtherRequest.model_json_schema(),
                "response": OtherResponse.model_json_schema(),
            },
        },
        "error": ErrorResponse.model_json_schema(),
    }


def export_json() -> str:
    return json.dumps(export_shapes(), indent=2, sort_keys=True) + "\n"


MODELS: dict[str, type[Contract]] = {
    model.__name__: model
    for model in (ShapesRequest, ShapesResponse, OtherRequest, OtherResponse)
}


def accepts(model: str, value: object) -> bool:
    """Whether the model accepts the value as JSON, as the service parses it."""
    try:
        MODELS[model].model_validate_json(json.dumps(value))
    except ValidationError:
        return False
    return True


if __name__ == "__main__":
    if sys.argv[1:] == ["--validate"]:
        cases = json.load(sys.stdin)
        print(json.dumps([accepts(case["model"], case["value"]) for case in cases]))
    else:
        print(export_json(), end="")
