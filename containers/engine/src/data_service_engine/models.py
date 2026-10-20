from datetime import date
from typing import Any, Literal

import polars as pl
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    field_validator,
    model_validator,
)

from .errors import CalculationError


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


class Snapshot(Contract):
    """Holdings at the close of `holdings_date`, in effect until the next one.

    `holdings_date` is missing only for ad hoc holdings, which count as held
    at all times.
    """

    holdings_date: date | None = Field(None, alias="holdingsDate")
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


class Portfolio(Contract):
    """A portfolio and its holdings snapshots, sorted by date.

    `id` is missing for ad hoc portfolios. Those may send `holdings` instead
    of `snapshots`, as one undated snapshot.
    """

    id: str | None = Field(default=None, min_length=1)
    name: str | None = None
    snapshots: tuple[Snapshot, ...]

    @model_validator(mode="before")
    @classmethod
    def _plain_holdings(cls, data: Any) -> Any:
        if isinstance(data, dict) and "holdings" in data and "snapshots" not in data:
            data = {**data, "snapshots": [{"holdings": data["holdings"]}]}
            del data["holdings"]
        return data

    @field_validator("snapshots")
    @classmethod
    def _dated_and_sorted(cls, snapshots: tuple[Snapshot, ...]):
        if not snapshots:
            raise ValueError("A portfolio needs at least one snapshot")
        dates = [snapshot.holdings_date for snapshot in snapshots]
        if None in dates and len(dates) > 1:
            raise ValueError("Only a single snapshot can be undated")
        if len(set(dates)) != len(dates):
            raise ValueError("Each holdings date can appear only once")
        return tuple(sorted(snapshots, key=lambda s: s.holdings_date or date.min))

    def until(self, day: date) -> "Portfolio":
        """The portfolio as known at the close of `day`. May have no snapshots."""
        known = tuple(s for s in self.snapshots if _effective_by(s, day))
        return self.model_copy(update={"snapshots": known})

    def holdings_at(self, day: date) -> Snapshot:
        """The snapshot in effect at the close of `day`."""
        for snapshot in reversed(self.snapshots):
            if _effective_by(snapshot, day):
                return snapshot
        raise CalculationError(f"No holdings on or before {day}")

    def snapshots_between(self, start: date, end: date) -> tuple[Snapshot, ...]:
        """Every snapshot in effect at some close from `start` to `end`.

        That's the one in effect at `start`, if any, and those dated after it
        up to `end`.
        """
        first = self._in_effect(start)
        return tuple(
            snapshot
            for snapshot in self.snapshots
            if snapshot is first
            or (
                snapshot.holdings_date is not None
                and start < snapshot.holdings_date <= end
            )
        )

    def holdings_df(self, start: date, end: date) -> pl.DataFrame:
        """`snapshots_between` as rows of `holdings_date`, `symbol`, `weight`."""
        return pl.DataFrame(
            [
                {
                    "holdings_date": snapshot.holdings_date,
                    "symbol": holding.symbol,
                    "weight": holding.weight,
                }
                for snapshot in self.snapshots_between(start, end)
                for holding in snapshot.holdings
            ],
            schema={
                "holdings_date": pl.Date,
                "symbol": pl.String,
                "weight": pl.Float64,
            },
        )

    @property
    def symbols(self) -> list[str]:
        """Every symbol held in any snapshot, in first-seen order."""
        return list(
            dict.fromkeys(symbol for s in self.snapshots for symbol in s.symbols)
        )

    def _in_effect(self, day: date) -> Snapshot | None:
        try:
            return self.holdings_at(day)
        except CalculationError:
            return None


def _effective_by(snapshot: Snapshot, day: date) -> bool:
    return snapshot.holdings_date is None or snapshot.holdings_date <= day


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
        if any(s.holdings_date is None for p in portfolios for s in p.snapshots):
            raise ValueError("Saved portfolios' snapshots need a holdings date")
        if len(set(ids)) != len(ids):
            raise ValueError("Each portfolio can appear only once")
        return portfolios


class PortfolioOutcome(Contract):
    portfolio_id: str | None = Field(serialization_alias="portfolioId")
    status: Literal["completed", "failed"]
    row_count: int = Field(default=0, serialization_alias="rowCount")
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
