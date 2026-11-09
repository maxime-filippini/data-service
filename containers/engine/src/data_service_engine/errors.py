from pydantic import ValidationError


class CalculationError(Exception):
    """An expected failure, e.g. not enough data. Its message is shown as is."""


class MissingDataError(CalculationError):
    """Required canonical symbol data is absent.

    Raised by symbol loading and reported as an expected calculation failure
    for that portfolio; callers should not substitute an empty dataset.
    """


class UnknownTypeError(CalculationError):
    """The requested registry key has no installed calculation type.

    HTTP type lookup maps this to not found; saved-run execution reports it
    through its normal failed-result path.
    """


class CalculationFailed(Exception):
    """A synchronous calculation failed without a usable result."""


class BatchCalculationFailed(Exception):
    """Atomic portfolio-helper failure with input position and error category."""

    def __init__(self, index: int, portfolio_id: str | None, cause: Exception):
        self.index = index
        self.portfolio_id = portfolio_id
        self.status = 422 if isinstance(cause, CalculationError) else 500
        super().__init__(describe_error(cause))


def describe_error(error: Exception) -> str:
    """A bounded message suitable for API errors and stored run outcomes."""
    if isinstance(error, CalculationError):
        message = str(error)
    elif isinstance(error, ValidationError):
        message = f"Invalid {error.title}: " + "; ".join(
            f"{'.'.join(map(str, e['loc'])) or 'value'}: {e['msg']}"
            for e in error.errors()
        )
    else:
        message = f"{type(error).__name__}: {error}"
    return message[:500]
