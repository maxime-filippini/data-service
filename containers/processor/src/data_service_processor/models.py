from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, StrictInt


class Contract(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class DateRange(Contract):
    start: date = Field(alias="from")
    end: date = Field(alias="to")


class RawInput(Contract):
    run_id: str = Field(alias="runId", min_length=1)
    provider: Literal["eodhd"]
    requested_range: DateRange = Field(alias="requestedRange")
    key: str = Field(min_length=1)
    etag: str = Field(min_length=1)
    row_count: int = Field(alias="rowCount", ge=0)


class Manifest(Contract):
    """One job sent by the Worker: rebuild `output_key` from one raw object."""

    job_id: str = Field(alias="jobId", min_length=1)
    dataset: Literal["prices_eod"]
    symbol: str = Field(min_length=1)
    output_key: str = Field(alias="outputKey", min_length=1)
    input: RawInput


class Entry(Contract):
    date: date
    open: FiniteFloat
    close: FiniteFloat
    high: FiniteFloat
    low: FiniteFloat
    adjusted_close: FiniteFloat
    volume: StrictInt = Field(ge=0)


class Envelope(Contract):
    version: Literal[1]
    run_id: str = Field(alias="runId")
    dataset: Literal["prices_eod"]
    provider: Literal["eodhd"]
    symbol: str
    requested_range: DateRange = Field(alias="requestedRange")
    entries: list[Entry]
