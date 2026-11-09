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
