"""``recurring.detect``: find the user's recurring charges and update their status (spec 009).

Once written, it asks for a refresh of the month's open check-in (spec 015
rule 15), so the refresh reads the charges the sync just revealed.
"""

from __future__ import annotations

from typing import Any

from checkin.engine import queue_refresh
from db.person_day import person_day
from jobs.context import JobContext
from sync.recurring import run_detection


def detect(ctx: JobContext) -> dict[str, Any]:
    with ctx.user_session() as session:
        # The person's today and month at the job clock (spec 019 rule 9).
        day = person_day(session, ctx.user_id, ctx.services.clock())
        result = run_detection(session, ctx.user_id, day.today)
        queue_refresh(session, ctx.user_id, day.month)
    return result.as_job_result()
