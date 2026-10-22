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
    "CHECK_INS",
    "COUNTER_RETENTION",
    "CSV_IMPORTS",
    "DECISIONS",
    "EXPLAIN_RUNS",
    "EXTRACTIONS",
    "LINKS",
    "LINK_TOKENS",
    "MANUAL_SYNCS",
    "PLAN_EXPORTS",
    "UPLOADS",
    "WRITE_ROUTE_POLICIES",
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


HOUR = dt.timedelta(hours=1)

UPLOADS = Limit(bucket="docs.upload", limit=10, window=HOUR)
# Explain runs that reach the model (spec 008 rule 22); stored answers are free.
EXPLAIN_RUNS = Limit(bucket="explain.run", limit=30, window=HOUR)
# Each queues a Sonnet call in the worker; the daily LLM budget is the second guard.
EXTRACTIONS = Limit(bucket="docs.extract", limit=20, window=HOUR)
# Each writes an immutable version that is never deleted while the account lives.
DECISIONS = Limit(bucket="decisions.save", limit=60, window=HOUR)
# Each queues a WeasyPrint render and stores a PDF for 7 days.
PLAN_EXPORTS = Limit(bucket="plan.export", limit=10, window=HOUR)
# Each queues a check-in run: the finders, the reconcile and their writes.
CHECK_INS = Limit(bucket="checkins.run", limit=10, window=HOUR)
# Plaid calls billed or rate limited per client id, not per user.
LINK_TOKENS = Limit(bucket="sync.link_token", limit=30, window=HOUR)
LINKS = Limit(bucket="sync.link", limit=10, window=HOUR)
MANUAL_SYNCS = Limit(bucket="sync.manual", limit=30, window=HOUR)
# Parses up to 10 MB and runs the sync pipeline inside the request.
CSV_IMPORTS = Limit(bucket="accounts.import", limit=20, window=HOUR)

_OWN_ROW = (
    "updates one of the user's own rows with a small validated body; repeating it"
    " changes nothing more and touches no other service"
)
# Every route that is not a GET, by operation id: its limit, or why it has none.
# tests/unit/test_write_route_policies.py fails on a route missing here.
WRITE_ROUTE_POLICIES: dict[str, Limit | str] = {
    "upload_document": UPLOADS,
    "extract_document": EXTRACTIONS,
    "explain": EXPLAIN_RUNS,
    "save_decision": DECISIONS,
    "export_plan": PLAN_EXPORTS,
    "check_in_now": CHECK_INS,
    "create_link_token": LINK_TOKENS,
    "link_item": LINKS,
    "sync_item": MANUAL_SYNCS,
    "import_csv": CSV_IMPORTS,
    "confirm_document": (
        "succeeds once per document (a confirmed document is 409), and documents are"
        " bounded by the upload limit"
    ),
    "delete_item": (
        "deletes one linked institution, which then no longer exists; links are"
        " bounded by the link limit"
    ),
    "delete_account": "succeeds once per account; a repeat is one empty read and a no-op delete",
    "plaid_webhook": (
        "has no user; the signature is verified before any database work, the body is"
        " bounded, and a queued sync per item is never duplicated"
    ),
    "calc_401k_match": "pure computation on a bounded, validated body; no database, no I/O",
    "calc_emergency_fund": "pure computation on a bounded, validated body; no database, no I/O",
    "calc_health_plans": (
        "pure computation on a bounded, validated body (at most MAX_PLANS plans); no database"
    ),
    "calc_w4": "pure computation on a bounded, validated body; no database, no I/O",
    "update_account": _OWN_ROW,
    "update_transaction_category": (
        "writes one user rule and relabels that merchant's own transactions; bounded by"
        " the user's data"
    ),
    "update_recurring": _OWN_ROW,
    "update_goal": _OWN_ROW,
    "update_finding": _OWN_ROW,
    "put_profile": _OWN_ROW,
}
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
