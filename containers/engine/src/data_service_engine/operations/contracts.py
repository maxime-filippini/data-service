"""The uniform operation contract shared with the Worker.

Every operation receives `{execution, inputs, params}` and returns a small
JSON object; failures return `{error: {kind, message, issues}}` with a non-2xx
status. These Pydantic models are the source of truth: their exported JSON
Schemas generate the Worker's TypeScript contracts
(`src/operations/contracts.generated.ts`).
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from .errors import FailureKind

UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
STEP_ID_PATTERN = r"^[A-Za-z][A-Za-z0-9_-]{0,63}$"
SYMBOL_PATTERN = r"^[A-Z0-9][A-Z0-9-]*(\.[A-Z0-9][A-Z0-9-]*)?$"
# The same run namespace as the Worker's `runArtifactId`:
# runs/<runId>/<stepId>/<name>.<json|parquet>
ARTIFACT_ID_PATTERN = (
    r"^runs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"/[A-Za-z][A-Za-z0-9_-]{0,63}/[A-Za-z][A-Za-z0-9_-]{0,63}\.(json|parquet)$"
)


class Contract(BaseModel):
    """Base for JSON crossing the Worker/operation boundary: camelCase on the
    wire, and unknown fields are rejected rather than ignored."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
        extra="forbid",
    )


class Execution(Contract):
    """Which run and step asks for the work. Outputs are written to locations
    derived from it, so a repeated call replaces the same objects."""

    run_id: str = Field(pattern=UUID_PATTERN)
    step_id: str = Field(pattern=STEP_ID_PATTERN)


class OperationRequest(Contract):
    """The uniform request. Each operation narrows `inputs` and `params`."""

    execution: Execution


class RawPricesEodReference(Contract):
    """A run artifact holding one provider's raw end-of-day price response."""

    id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    format: Literal["json"]
    schema_: Literal["raw-prices-eod/v1"] = Field(alias="schema")


class PricesEodReference(Contract):
    """A run artifact holding normalized end-of-day prices as Parquet."""

    id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    format: Literal["parquet"]
    schema_: Literal["prices-eod/v1"] = Field(alias="schema")


class Issue(Contract):
    """One problem with a request, at a path such as `inputs.raw.id`."""

    path: list[str]
    message: str


class OperationFailure(Contract):
    """Why an operation failed. The caller retries `transient` failures and
    stops the run on `terminal` ones."""

    kind: FailureKind
    message: str
    issues: list[Issue] = Field(default_factory=list)


class ErrorResponse(Contract):
    """The body of every non-2xx operation response."""

    error: OperationFailure
