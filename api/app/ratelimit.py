"""Per-user fixed-window rate limits on a Postgres counter (spec 004 rule 5).

``consume`` increments the user's counter for the current window with one
``INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`` inside the request's
transaction. Concurrent requests serialize on the row, so they cannot both slip
under the limit, and a request that fails afterwards (or is refused here)
rolls its increment back with everything else.
"""

from __future__ import annotations

import datetime as dt
import math
import uuid
from dataclasses import dataclass

from sqlalchemy import Connection, delete
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.errors import AppError
from db.models import RateLimitCounter

__all__ = [
    "COUNTER_RETENTION",
    "EXPLAIN_RUNS",
    "UPLOADS",
    "Limit",
    "RateLimited",
    "consume",
    "prune_counters",
    "window_start",
]


@dataclass(frozen=True)
class Limit:
    bucket: str
    limit: int
    # Windows are aligned to the epoch: an hour window is a clock hour in UTC.
    window: dt.timedelta


UPLOADS = Limit(bucket="docs.upload", limit=10, window=dt.timedelta(hours=1))
# Explain runs that reach the model (spec 008 rule 22); stored answers are free.
EXPLAIN_RUNS = Limit(bucket="explain.run", limit=30, window=dt.timedelta(hours=1))
# Counters are only read for the current window; older ones are pruned.
COUNTER_RETENTION = dt.timedelta(days=1)


class RateLimited(AppError):
    status_code = 429
    code = "rate_limited"

    def __init__(self, retry_after: int) -> None:
        super().__init__(
            f"Too many requests; try again in {retry_after} seconds",
            headers={"Retry-After": str(retry_after)},
        )


def window_start(now: dt.datetime, window: dt.timedelta) -> dt.datetime:
    epoch = dt.datetime(1970, 1, 1, tzinfo=dt.UTC)
    return epoch + ((now.astimezone(dt.UTC) - epoch) // window) * window


def prune_counters(connection: Connection, *, now: dt.datetime) -> int:
    """Delete counters whose window started more than a day before ``now``.

    Runs from the scheduler tick on the privileged connection, across users.
    """
    deleted = connection.execute(
        delete(RateLimitCounter)
        .where(RateLimitCounter.window_start < now - COUNTER_RETENTION)
        .returning(RateLimitCounter.user_id)
    ).all()
    return len(deleted)


def consume(session: Session, user_id: uuid.UUID, limit: Limit, *, now: dt.datetime) -> None:
    """Count one request; raise ``RateLimited`` past the limit."""
    start = window_start(now, limit.window)
    statement = (
        insert(RateLimitCounter)
        .values(user_id=user_id, bucket=limit.bucket, window_start=start, count=1)
        .on_conflict_do_update(
            index_elements=[
                RateLimitCounter.user_id,
                RateLimitCounter.bucket,
                RateLimitCounter.window_start,
            ],
            set_={"count": RateLimitCounter.count + 1},
        )
        .returning(RateLimitCounter.count)
    )
    count = session.execute(statement).scalar_one()
    if count > limit.limit:
        remaining = (start + limit.window - now).total_seconds()
        raise RateLimited(max(1, math.ceil(remaining)))
