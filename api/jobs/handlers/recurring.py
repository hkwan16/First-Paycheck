"""``recurring.detect``: find the user's recurring charges and update their status (spec 009)."""

from __future__ import annotations

from typing import Any

from jobs.context import JobContext
from sync.recurring import run_detection


def detect(ctx: JobContext) -> dict[str, Any]:
    today = ctx.services.clock().date()
    with ctx.user_session() as session:
        result = run_detection(session, ctx.user_id, today)
    return result.as_job_result()
