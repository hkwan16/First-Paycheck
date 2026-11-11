"""``plan.export``: render the user's plan as a PDF (spec 016 rules 10-14). Worker only.

The plan is read in one short user session (RLS), rendered with no
transaction open (WeasyPrint takes a second or two), and stored in a second
user session. A rerun of a job whose PDF is already stored (a stale requeue
after the first run wrote it) renders nothing and keeps the first.
"""

from __future__ import annotations

from typing import Any

from app.plan import build_plan
from db.person_day import person_day
from export import store
from export.html import render_html
from export.pdf import render_pdf
from jobs.context import JobContext

SKIPPED: dict[str, Any] = {"status": "skipped"}


def run(ctx: JobContext) -> dict[str, Any]:
    now = ctx.services.clock()
    with ctx.user_session() as session:
        if store.get(session, ctx.job.id) is not None:
            return SKIPPED
        # As of the person's today (spec 019 rule 12): the date the PDF prints.
        plan = build_plan(session, person_day(session, ctx.user_id, now).today)
    ctx.progress(30)
    pdf = render_pdf(render_html(plan))
    ctx.progress(90)
    with ctx.user_session() as session:
        stored = store.put(
            session, job_id=ctx.job.id, user_id=ctx.user_id, data=pdf, created_at=now
        )
    if not stored:
        return SKIPPED
    return {"size_bytes": len(pdf), "prepared_on": plan.as_of.isoformat()}
