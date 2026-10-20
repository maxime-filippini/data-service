class CalculationError(Exception):
    """An expected failure, e.g. not enough data. Its message is shown as is."""


class MissingDataError(CalculationError):
    pass


class UnknownTypeError(CalculationError):
    pass
