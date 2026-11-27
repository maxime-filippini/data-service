"""Calculate ex-ante volatility from an effective snapshot and published prices."""

import io
from datetime import date
from math import isfinite
from typing import Literal, Self

import polars as pl
from pydantic import Field, FiniteFloat, field_validator, model_validator

from ..errors import CalculationError
from . import ex_ante_vol
from .artifacts import PARQUET, ArtifactStore, run_artifact_id
from .contracts import (
    ARTIFACT_ID_PATTERN,
    SYMBOL_PATTERN,
    UUID_PATTERN,
    Contract,
    OperationRequest,
)
from .errors import TerminalError
from .published import PublishedPrices
from .registry import Operation


class PriceAsset(Contract):
    kind: Literal["asset"]
    symbol: str = Field(pattern=SYMBOL_PATTERN)


class PublishedAssetPrice(Contract):
    """Identity of a matching publication, resolved against current storage."""

    dataset: Literal["prices_eod"]
    subject: PriceAsset
    processing_date: date
    workflow_id: str = Field(pattern=UUID_PATTERN)
    run_id: str = Field(pattern=UUID_PATTERN)


class VolatilityHolding(Contract):
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    weight: FiniteFloat

    @field_validator("weight")
    @classmethod
    def _non_zero(cls, weight: float) -> float:
        if weight == 0:
            raise ValueError("Weight must be non-zero")
        return weight


class PortfolioVolatilityInputs(Contract):
    portfolio_id: str = Field(pattern=UUID_PATTERN)
    processing_date: date
    holdings_date: date
    holdings: tuple[VolatilityHolding, ...] = Field(min_length=1)
    publications: tuple[PublishedAssetPrice, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def _match_holdings_to_publications(self) -> Self:
        if self.holdings_date > self.processing_date:
            raise ValueError("Holdings must be effective by the processing date")
        holdings = {holding.symbol for holding in self.holdings}
        publications = {ref.subject.symbol for ref in self.publications}
        if len(holdings) != len(self.holdings):
            raise ValueError("Each holding symbol can appear only once")
        if len(publications) != len(self.publications) or holdings != publications:
            raise ValueError("Supply exactly one price publication per holding")
        if any(
            ref.processing_date != self.processing_date for ref in self.publications
        ):
            raise ValueError("Price publications must match the processing date")
        return self


class PortfolioVolatilityParams(ex_ante_vol.Params):
    """The same numerical parameters and defaults as the existing calculation."""


class PortfolioVolatilityRequest(OperationRequest):
    inputs: PortfolioVolatilityInputs
    params: PortfolioVolatilityParams


class PortfolioVolatilityReference(Contract):
    id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    format: Literal["parquet"]
    schema_: Literal["portfolio-volatility/v1"] = Field(alias="schema")


class PortfolioVolatilitySummary(Contract):
    volatility: FiniteFloat
    observations: int = Field(ge=2)
    window_start: date
    window_end: date
    holdings_date: date


class PortfolioVolatilityOutputs(Contract):
    data: PortfolioVolatilityReference
    summary: PortfolioVolatilitySummary


def calculate(
    request: PortfolioVolatilityRequest,
    artifacts: ArtifactStore,
    published_prices: PublishedPrices,
) -> PortfolioVolatilityOutputs:
    inputs = request.inputs
    references = {ref.subject.symbol: ref for ref in inputs.publications}

    def load(dataset: str, symbol: str) -> pl.DataFrame:
        reference = references.get(symbol)
        if reference is None or reference.dataset != dataset:
            raise TerminalError(f"No {dataset} price reference for {symbol}")
        data = published_prices.read(reference.subject.symbol)
        if data is None:
            raise TerminalError(f"No published {dataset} prices for {symbol}")
        try:
            return pl.read_parquet(io.BytesIO(data), columns=["date", "adjusted_close"])
        except pl.exceptions.PolarsError as error:
            raise TerminalError(
                f"Invalid published {dataset} prices for {symbol}"
            ) from error

    holdings = {holding.symbol: holding.weight for holding in inputs.holdings}
    try:
        result = ex_ante_vol.run(
            request.params,
            as_of=inputs.processing_date,
            holdings_date=inputs.holdings_date,
            holdings=holdings,
            load_symbol=load,
        )
    except (CalculationError, OverflowError, pl.exceptions.PolarsError) as error:
        raise TerminalError(str(error)) from error
    row = result.row(0, named=True)
    if not isfinite(row["volatility"]):
        raise TerminalError(
            "Volatility is not finite for the supplied prices and weights"
        )
    summary = PortfolioVolatilitySummary.model_validate(row)

    result = result.select(
        pl.lit(inputs.processing_date, pl.Date).alias("as_of"),
        pl.lit(inputs.portfolio_id, pl.String).alias("portfolio_id"),
        pl.all(),
    )
    artifact_id = run_artifact_id(request.execution, "volatility", "parquet")
    output = io.BytesIO()
    result.write_parquet(output)
    artifacts.write(artifact_id, output.getvalue(), PARQUET)
    return PortfolioVolatilityOutputs(
        data=PortfolioVolatilityReference(
            id=artifact_id, format="parquet", schema_="portfolio-volatility/v1"
        ),
        summary=summary,
    )


OPERATION = Operation(
    name="calculate-portfolio-volatility",
    description="Annualised ex-ante volatility from an effective holdings snapshot and published asset prices",
    request=PortfolioVolatilityRequest,
    response=PortfolioVolatilityOutputs,
    run=lambda request, storage: calculate(
        request, storage.artifacts, storage.published_prices
    ),
)
