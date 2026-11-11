"""``checkin.monthly``: build or refresh one month's check-in (spec 015 rules 8-16)."""

from __future__ import annotations

import datetime as dt
from typing import Any

from checkin.engine import Trigger, run_check_in
from jobs.context import JobContext

TRIGGERS: tuple[Trigger, ...] = ("schedule", "sync")


def parse_payload(payload: dict[str, Any]) -> tuple[dt.date, Trigger]:
    """``{"period": "YYYY-MM-01", "trigger": "schedule" | "sync"}``; anything else raises."""
    try:
        period = dt.date.fromisoformat(str(payload["period"]))
    except (KeyError, ValueError):
        raise ValueError("period is missing or not an ISO date") from None
    if period.day != 1:
        raise ValueError(f"period must be the first day of a month, not {period}")
    trigger = payload.get("trigger")
    for known in TRIGGERS:
        if trigger == known:
            return period, known
    raise ValueError(f"trigger must be one of {TRIGGERS}, not {trigger!r}")


def run(ctx: JobContext) -> dict[str, Any]:
    period, trigger = parse_payload(ctx.job.payload)
    # Rule 16 and spec 019 rule 11: the run judges the person's today at the job
    # clock, kept within the month (checkin.engine.run_date).
    with ctx.user_session() as session:
        result = run_check_in(
            session, ctx.user_id, period, now=ctx.services.clock(), trigger=trigger
        )
    return result.as_job_result()
