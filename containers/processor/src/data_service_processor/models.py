"""JSON contracts received from the Worker and raw R2 objects.

Worker ProcessingManifest and EodEntrySchema are their TypeScript counterparts;
these models describe processing input rather than database records.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, StrictInt


class Contract(BaseModel):
    """Base for JSON models crossing the Worker/processor interface.

    Allow both Python field names and Worker camelCase aliases on input.
    These models validate received values; they do not read R2 or alter job state.
    """

    model_config = ConfigDict(populate_by_name=True)


class DateRange(Contract):
    """Inclusive requested history bounds, encoded as `from`/`to` in JSON.

    Used to compare raw-object provenance with a job manifest and to reject
    rows outside its requested range during processing.
    """

    start: date = Field(alias="from")
    end: date = Field(alias="to")


class RawInput(Contract):
    """Expected raw-object contents pinned by a processing job.

    The processor reads `key` with an ETag condition, then checks envelope
    identity, requested range and row count against these values.
    """

    run_id: str = Field(alias="runId", min_length=1)
    provider: Literal["eodhd"]
    requested_range: DateRange = Field(alias="requestedRange")
    key: str = Field(min_length=1)
    etag: str = Field(min_length=1)
    row_count: int = Field(alias="rowCount", ge=0)


class Manifest(Contract):
    """Worker POST /jobs payload for rebuilding one canonical Parquet object.

    Matches TypeScript ProcessingManifest. Pins a completed ingestion through
    `input` and names the output destination; the Worker retains ownership of
    the D1 job and records the returned ETag.
    """

    job_id: str = Field(alias="jobId", min_length=1)
    dataset: Literal["prices_eod"]
    symbol: str = Field(min_length=1)
    output_key: str = Field(alias="outputKey", min_length=1)
    input: RawInput


class Entry(Contract):
    """Validated end-of-day row read from a raw envelope.

    Mirrors EodEntrySchema in the Worker. The processor converts these rows
    to the dataset Parquet schema, resolving duplicate dates during rebuilding.
    """

    date: date
    open: FiniteFloat
    close: FiniteFloat
    high: FiniteFloat
    low: FiniteFloat
    adjusted_close: FiniteFloat
    volume: StrictInt = Field(ge=0)


class Envelope(Contract):
    """Validated subset of a version-1 raw ingestion JSON object stored in R2.

    Contains the full snapshot used to rebuild a symbol, not an incremental
    patch. Metadata needed for processing is checked against Manifest.input;
    other envelope metadata, such as receivedAt, is not needed by this model.
    """

    version: Literal[1]
    run_id: str = Field(alias="runId")
    dataset: Literal["prices_eod"]
    provider: Literal["eodhd"]
    symbol: str
    requested_range: DateRange = Field(alias="requestedRange")
    entries: list[Entry]
