"""Exceptions a job handler raises to steer the queue."""

from __future__ import annotations

MAX_RETRY_AFTER_SECONDS = 86_400


class RetryLater(Exception):
    """The work cannot be done yet (for example Plaid's PRODUCT_NOT_READY).

    The queue treats it as a failed attempt, waiting at least
    ``after_seconds`` before the next one (spec 002 rule 34).
    """

    def __init__(self, message: str, *, after_seconds: int = 0) -> None:
        if not 0 <= after_seconds <= MAX_RETRY_AFTER_SECONDS:
            raise ValueError(f"after_seconds must be 0-{MAX_RETRY_AFTER_SECONDS}")
        super().__init__(message)
        self.after_seconds = after_seconds


class UnknownJobKind(LookupError):
    """No handler is registered for a job's kind."""
