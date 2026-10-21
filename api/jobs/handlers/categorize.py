"""``categorize.run``: label the user's uncategorized transactions (spec 003)."""

from __future__ import annotations

from typing import Any

from jobs.context import JobContext
from sync.categorize import categorize_user


def run(ctx: JobContext) -> dict[str, Any]:
    # A worker without a gateway still applies the rules (spec 003 rule 12a).
    result = categorize_user(
        user_id=ctx.user_id,
        sessions=ctx.user_session,
        labeler=ctx.services.labeler,
        job_id=ctx.job.id,
        progress=ctx.progress,
    )
    return result.as_job_result()
