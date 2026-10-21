"""Retry schedule and error text for failed jobs (spec 002 rule 34)."""

from __future__ import annotations

import pytest

from jobs.errors import RetryLater
from jobs.queue import MAX_ATTEMPTS, backoff_seconds, error_text, retry_delay


def test_backoff_schedule() -> None:
    assert [backoff_seconds(n) for n in range(1, MAX_ATTEMPTS)] == [60, 120, 240, 480]
    assert MAX_ATTEMPTS == 5


def test_backoff_is_capped_at_one_hour() -> None:
    assert backoff_seconds(7) == 3600
    assert backoff_seconds(40) == 3600


def test_retry_later_waits_at_least_its_own_delay() -> None:
    assert retry_delay(1, RetryLater("not ready", after_seconds=300)) == 300
    assert retry_delay(4, RetryLater("not ready", after_seconds=30)) == 480
    assert retry_delay(2, ValueError("boom")) == 120


def test_error_text_names_the_type_and_is_truncated() -> None:
    assert error_text(ValueError("bad input")) == "ValueError: bad input"
    long = error_text(RuntimeError("x" * 2000))
    assert len(long) == 500
    assert long.startswith("RuntimeError: xxx")


@pytest.mark.parametrize("after", [-1, 86_401])
def test_retry_later_rejects_unreasonable_delays(after: int) -> None:
    with pytest.raises(ValueError, match="after_seconds"):
        RetryLater("x", after_seconds=after)
