from typing import Literal

FailureKind = Literal["transient", "terminal"]


class OperationError(Exception):
    """An operation failed in a way the caller should know how to handle.

    `transient` failures (storage or service trouble) may succeed when
    retried; `terminal` ones (invalid input, deterministic domain errors)
    fail the same way again. The message is shown to the maintainer as is.
    """

    kind: FailureKind = "terminal"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class TransientError(OperationError):
    """A failure a retry may fix, e.g. storage being unreachable."""

    kind = "transient"


class TerminalError(OperationError):
    """A failure a retry cannot fix, e.g. an invalid or missing input."""

    kind = "terminal"
