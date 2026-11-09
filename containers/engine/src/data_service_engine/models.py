"""JSON contracts for the engine and holdings helpers for calculation types.

CamelCase aliases match the Worker engine client. Requests contain resolved
inputs rather than Cloudflare bindings or instructions to change D1 state.
"""

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
    """Base for engine request/response models shared with the Worker.

    Accept field-name aliases on input and freeze model fields after creation.
    HTTP responses serialize aliases explicitly to match TypeScript wire types.
    """

    model_config = ConfigDict(populate_by_name=True, frozen=True)


class Holding(Contract):
    """One finite, non-zero exposure in saved or inline portfolio input.

    Negative weights and totals other than one are valid here. Calculation
    types decide whether normalization is needed; the Worker checks tracking.
    """

    symbol: str = Field(min_length=1)
    weight: FiniteFloat

    @field_validator("weight")
    @classmethod
    def _non_zero(cls, weight: float) -> float:
        if weight == 0:
            raise ValueError("Weight must be non-zero")
        return weight


class Snapshot(Contract):
    """Complete holdings effective at the close of `holdings_date`.

    The set remains in effect until the next snapshot. Calculation types use
    Portfolio helpers to choose relevant sets; it does not represent trades.
    An undated snapshot is allowed only for inline ad hoc holdings, treated
    as held at all times.
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
    """Engine-side holdings history used by calculation types.

    Saved requests include an ID and dated snapshots; ad hoc requests may
    omit the ID and send plain `holdings`, converted to one undated snapshot.
    Validation sorts dates and rejects duplicates. Query helpers resolve
    which complete sets are effective at the requested calculation dates.
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


class ValidateRequest(Contract):
    """POST /types/{name}/validate body containing proposed type parameters.

    The selected calculation type owns the Pydantic model that checks fields
    and supplies defaults; this wrapper only establishes the params object.
    """

    params: dict[str, Any]


class CalculateRequest(Contract):
    """POST /calculate payload for one result returned to the caller.

    Matches the Worker CalculateRequest. The as-of date limits visible data;
    portfolio input may be saved history or inline holdings, or absent for
    a type that takes none. Execution does not persist result history.
    """

    type: str = Field(min_length=1)
    params: dict[str, Any]
    as_of: date = Field(alias="asOf")
    portfolio: Portfolio | None = None


class RunRequest(Contract):
    """POST /runs payload for executing a saved calculation and writing history.

    Matches the Worker RunRequest. Portfolios must have IDs and dated
    snapshots; Python calculates and writes R2 while the Worker records D1
    state. A successful write replaces the as-of date rows at `output_key`.
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
    """Result of executing one type for one portfolio, before persistence.

    Used in saved-run responses and to determine ad hoc success. A null
    portfolio ID means the type ran without a portfolio. A completed outcome
    counts produced rows; the subsequent R2 write can still fail.
    """

    portfolio_id: str | None = Field(serialization_alias="portfolioId")
    status: Literal["completed", "failed"]
    row_count: int = Field(default=0, serialization_alias="rowCount")
    error: str | None = None


class RunResult(Contract):
    """POST /runs response that the Worker records against the saved D1 run.

    Mirrors the TypeScript engine RunResult. `partial` means some portfolio
    results were written while others failed. `failed` is returned as normal
    response data, including many runtime failures; it is not an HTTP error.
    """

    status: Literal["completed", "partial", "failed"]
    error: str | None = None
    portfolios: tuple[PortfolioOutcome, ...] = ()
    row_count: int = Field(0, serialization_alias="rowCount")
    output_etag: str | None = Field(None, serialization_alias="outputEtag")


def _effective_by(snapshot: Snapshot, day: date) -> bool:
    return snapshot.holdings_date is None or snapshot.holdings_date <= day
