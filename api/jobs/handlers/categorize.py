"""``categorize.run``: label the user's uncategorized transactions (spec 003)."""

from __future__ import annotations

from typing import Any

from jobs.context import JobContext
from sync.categorize import categorize_user


def run(ctx: JobContext) -> dict[str, Any]:
    labeler = ctx.services.labeler
    if labeler is None:
        raise RuntimeError("no LLM gateway is configured for this worker")
    result = categorize_user(
        user_id=ctx.user_id,
        sessions=ctx.user_session,
        labeler=labeler,
        job_id=ctx.job.id,
        progress=ctx.progress,
    )
    return result.as_job_result()
