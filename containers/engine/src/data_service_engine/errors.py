class CalculationError(Exception):
    """An expected numerical or domain failure, e.g. not enough price history."""


class MissingDataError(CalculationError):
    """Required canonical symbol data is absent."""
