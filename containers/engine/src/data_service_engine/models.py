from datetime import date
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    field_validator,
)


class Contract(BaseModel):
    model_config = ConfigDict(populate_by_name=True, frozen=True)


class Holding(Contract):
    symbol: str = Field(min_length=1)
    weight: FiniteFloat

    @field_validator("weight")
    @classmethod
    def _non_zero(cls, weight: float) -> float:
        if weight == 0:
            raise ValueError("Weight must be non-zero")
        return weight


class Portfolio(Contract):
    """A portfolio with its holdings already resolved by the Worker.

    `id` is missing for ad hoc portfolios sent as plain holdings.
    """

    id: str | None = Field(default=None, min_length=1)
    name: str | None = None
    holdings: tuple[Holding, ...] = Field(min_length=1)

    @field_validator("holdings")
    @classmethod
    def _unique_symbols(cls, holdings: tuple[Holding, ...]) -> tuple[Holding, ...]:
        symbols = [holding.symbol for holding in holdings]
        if len(set(symbols)) != len(symbols):
            raise ValueError("Each symbol can appear only once")
        return holdings

    @property
    def symbols(self) -> list[str]:
        return [holding.symbol for holding in self.holdings]

    @property
    def weights(self) -> dict[str, float]:
        return {holding.symbol: holding.weight for holding in self.holdings}


class ValidateRequest(Contract):
    params: dict[str, Any]


class CalculateRequest(Contract):
    """An ad hoc calculation. Nothing is saved; the result is returned."""

    type: str = Field(min_length=1)
    params: dict[str, Any]
    as_of: date = Field(alias="asOf")
    portfolio: Portfolio | None = None


class RunRequest(Contract):
    """One run of a saved calculation for one as-of date.

    The result rows replace the as-of date's rows in `output_key`.
    """

    run_id: str = Field(alias="runId", min_length=1)
    type: str = Field(min_length=1)
    params: dict[str, Any]
    as_of: date = Field(alias="asOf")
    portfolios: tuple[Portfolio, ...] = ()
    output_key: str = Field(alias="outputKey", min_length=1)

    @field_validator("portfolios")
    @classmethod
    def _saved_portfolios(cls, portfolios: tuple[Portfolio, ...]):
        ids = [portfolio.id for portfolio in portfolios]
        if None in ids:
            raise ValueError("Saved calculations only take portfolios with an id")
        if len(set(ids)) != len(ids):
            raise ValueError("Each portfolio can appear only once")
        return portfolios


class PortfolioOutcome(Contract):
    portfolio_id: str | None = Field(serialization_alias="portfolioId")
    status: Literal["completed", "failed"]
    row_count: int = Field(0, serialization_alias="rowCount")
    error: str | None = None


class RunResult(Contract):
    """What happened in a run. The Worker records it in D1.

    `partial` means some portfolios failed and the others were written.
    """

    status: Literal["completed", "partial", "failed"]
    error: str | None = None
    portfolios: tuple[PortfolioOutcome, ...] = ()
    row_count: int = Field(0, serialization_alias="rowCount")
    output_etag: str | None = Field(None, serialization_alias="outputEtag")
