"""Normalize one raw end-of-day price download into the `prices_eod` Parquet
schema.
"""

import io
from datetime import date
from typing import Literal

import polars as pl
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    StrictInt,
    ValidationError,
)

from .artifacts import PARQUET, ArtifactStore, run_artifact_id
from .contracts import (
    Contract,
    OperationRequest,
    PricesEodReference,
    RawPricesEodReference,
)
from .errors import TerminalError
from .registry import Operation

# The published `prices_eod` columns: a consumer contract read by the app's
# explorer and by calculations.
PRICES_EOD_SCHEMA = {
    "date": pl.Date,
    "open": pl.Float64,
    "close": pl.Float64,
    "high": pl.Float64,
    "low": pl.Float64,
    "adjusted_close": pl.Float64,
    "volume": pl.Int64,
}


class _Raw(BaseModel):
    """Raw envelopes are written by the Worker's download step. Metadata this
    model does not need, such as `receivedAt`, is ignored."""

    model_config = ConfigDict(populate_by_name=True)


class DateRange(_Raw):
    """Inclusive requested history bounds, `from`/`to` in JSON."""

    start: date = Field(alias="from")
    end: date = Field(alias="to")


class Entry(_Raw):
    """One validated end-of-day row, as the Worker's `EodEntrySchema`."""

    date: date
    open: FiniteFloat
    close: FiniteFloat
    high: FiniteFloat
    low: FiniteFloat
    adjusted_close: FiniteFloat
    volume: StrictInt = Field(ge=0)


class Envelope(_Raw):
    """A version-1 raw envelope: the full history snapshot one download
    requested, not an incremental patch."""

    version: Literal[1]
    run_id: str = Field(alias="runId")
    dataset: Literal["prices_eod"]
    provider: str
    symbol: str
    requested_range: DateRange = Field(alias="requestedRange")
    entries: list[Entry]


def build_prices_df(envelope: Envelope) -> pl.DataFrame:
    """Rebuild the full dataset from one snapshot, sorted by date; later rows
    win on duplicate dates."""
    return (
        pl.DataFrame(
            [row.model_dump() for row in envelope.entries], schema=PRICES_EOD_SCHEMA
        )
        .unique(subset=["date"], keep="last", maintain_order=True)
        .sort("date")
    )


class NormalizePricesInputs(Contract):
    raw: RawPricesEodReference


class NormalizePricesParams(Contract):
    """No parameters yet."""


class NormalizePricesRequest(OperationRequest):
    inputs: NormalizePricesInputs
    params: NormalizePricesParams


class NormalizePricesOutputs(Contract):
    prices: PricesEodReference


def _read_envelope(request: NormalizePricesRequest, artifacts: ArtifactStore):
    reference = request.inputs.raw
    body = artifacts.read(reference.id)
    if body is None:
        raise TerminalError(
            f"The raw artifact {reference.id} does not exist; it may have expired"
        )
    try:
        envelope = Envelope.model_validate_json(body)
    except ValidationError as error:
        raise TerminalError(
            f"The raw artifact is not a valid raw-prices-eod/v1 envelope: "
            f"{error.error_count()} problem(s), first: "
            f"{error.errors(include_url=False)[0]['msg']}"
        ) from error
    if envelope.run_id != request.execution.run_id:
        raise TerminalError("The raw artifact belongs to another run")
    bounds = envelope.requested_range
    if any(not bounds.start <= row.date <= bounds.end for row in envelope.entries):
        raise TerminalError("A raw entry lies outside the requested range")
    return envelope


def normalize_prices(
    request: NormalizePricesRequest, artifacts: ArtifactStore
) -> NormalizePricesOutputs:
    """Validate the raw download, build the `prices_eod` table and write it as
    the step's `prices.parquet` artifact. The output ID is fixed by the run
    and step, so repeating the call replaces the same object."""
    envelope = _read_envelope(request, artifacts)
    df = build_prices_df(envelope)
    output = io.BytesIO()
    df.write_parquet(output)
    prices = PricesEodReference(
        id=run_artifact_id(request.execution, "prices", "parquet"),
        format="parquet",
        schema="prices-eod/v1",
    )
    artifacts.write(prices.id, output.getvalue(), PARQUET)
    return NormalizePricesOutputs(prices=prices)


OPERATION = Operation(
    name="normalize-prices-eod",
    description=(
        "Validate a raw end-of-day price download and write it as a date-sorted"
        " prices_eod Parquet artifact; later rows win on duplicate dates"
    ),
    request=NormalizePricesRequest,
    response=NormalizePricesOutputs,
    run=normalize_prices,
)
