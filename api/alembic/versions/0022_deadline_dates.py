"""Date findings keyed by the date, and overdue dates (spec 015 rules 7, 12 and 13b;
issues 233 and 234).

Before this revision an ``upcoming_deadline`` finding was keyed by its
calendar event's row, ``upcoming_deadline:{event_id}``. A newer version of a
decision dismisses its old events and adds new ones (spec 007 rule 14), so the
same reminder on the same day got a new key: Check in now reported one new
finding and one that no longer applied over cards that read the same, and a
date one month reported could be reported again the next.

The upgrade adds ``overdue_deadline`` to ``finding_kind`` after
``upcoming_deadline`` (the type is rebuilt, as 0021 did, so the label can be
used at once) and keys every ``upcoming_deadline`` finding by its date,
``upcoming_deadline:{calendar_kind}:{due_at}``, from its payload. Findings of
one check-in that then share a key become one: the newest keeps its row and
payload, and it has a user action only when every one of them had one (the
newest action, as rule 13a.3), so the check-in keeps its status.

The downgrade deletes the ``overdue_deadline`` findings, applies rule 13 to
the check-ins they were on, keys the date findings by their event again and
rebuilds the type without the label. Folded findings stay folded.

No new table or function.

Revision ID: 0022_deadline_dates
Revises: 0021_paycheck_change
Create Date: 2026-11-09
"""

import datetime as dt
from collections import defaultdict
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0022_deadline_dates"
down_revision: str | None = "0021_paycheck_change"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS_BEFORE = (
    "election_mismatch",
    "goal_off_pace",
    "recurring_new",
    "recurring_changed",
    "recurring_stopped",
    "pay_change",
    "upcoming_deadline",
)
KINDS_AFTER = (*KINDS_BEFORE, "overdue_deadline")

Row = dict[str, Any]


def _rebuild_kinds(labels: tuple[str, ...]) -> None:
    op.execute("ALTER TYPE public.finding_kind RENAME TO finding_kind_old")
    values = ", ".join(f"'{label}'" for label in labels)
    op.execute(f"CREATE TYPE public.finding_kind AS ENUM ({values})")
    op.execute(
        "ALTER TABLE public.check_in_findings ALTER COLUMN kind TYPE public.finding_kind"
        " USING kind::text::public.finding_kind"
    )
    op.execute("DROP TYPE public.finding_kind_old")


def _date_findings(bind: sa.Connection) -> list[Row]:
    rows = bind.execute(
        sa.text(
            "SELECT id, check_in_id, key, payload, user_action::text AS user_action,"
            " user_action_at FROM public.check_in_findings"
            " WHERE kind::text = 'upcoming_deadline' ORDER BY created_at, id"
        )
    ).all()
    return [dict(row._mapping) for row in rows]


def _action(group: list[Row]) -> tuple[str | None, dt.datetime | None]:
    """Rule 13b, as rule 13a.3: handled only when every finding folded in was."""
    if any(row["user_action"] is None for row in group):
        return None, None
    newest = max(group, key=lambda row: row["user_action_at"])
    return newest["user_action"], newest["user_action_at"]


def upgrade() -> None:
    _rebuild_kinds(KINDS_AFTER)
    bind = op.get_bind()
    groups: dict[tuple[Any, str], list[Row]] = defaultdict(list)
    for row in _date_findings(bind):
        payload = row["payload"]
        key = f"upcoming_deadline:{payload['calendar_kind']}:{payload['due_at']}"
        groups[(row["check_in_id"], key)].append(row)
    for (_, key), group in groups.items():
        newest = group[-1]
        older = [row["id"] for row in group[:-1]]
        if older:
            bind.execute(
                sa.text("DELETE FROM public.check_in_findings WHERE id = ANY(:ids)"),
                {"ids": older},
            )
        action, at = _action(group)
        bind.execute(
            sa.text(
                "UPDATE public.check_in_findings SET key = :key,"
                " user_action = CAST(:action AS public.finding_action), user_action_at = :at"
                " WHERE id = :id"
            ),
            {"id": newest["id"], "key": key, "action": action, "at": at},
        )


def downgrade() -> None:
    bind = op.get_bind()
    touched = bind.execute(
        sa.text(
            "DELETE FROM public.check_in_findings WHERE kind::text = 'overdue_deadline'"
            " RETURNING check_in_id"
        )
    ).scalars()
    check_ins = sorted({str(check_in) for check_in in touched})
    # Rule 13 again: completed when every finding left (at least one) has an action.
    bind.execute(
        sa.text(
            """
            UPDATE public.check_ins AS c
            SET status = CASE WHEN f.total > 0 AND f.total = f.handled
                              THEN 'completed'::public.checkin_status
                              ELSE 'open'::public.checkin_status END,
                completed_at = CASE WHEN f.total > 0 AND f.total = f.handled
                                    THEN coalesce(c.completed_at, f.last_action) END
            FROM (
              SELECT c2.id, count(x.id) AS total, count(x.user_action) AS handled,
                     max(x.user_action_at) AS last_action
              FROM public.check_ins AS c2
              LEFT JOIN public.check_in_findings AS x ON x.check_in_id = c2.id
              WHERE c2.id = ANY(CAST(:ids AS uuid[]))
              GROUP BY c2.id
            ) AS f
            WHERE c.id = f.id
            """
        ),
        {"ids": check_ins},
    )
    bind.execute(
        sa.text(
            "UPDATE public.check_in_findings"
            " SET key = 'upcoming_deadline:' || (payload->>'calendar_event_id')"
            " WHERE kind::text = 'upcoming_deadline'"
        )
    )
    _rebuild_kinds(KINDS_BEFORE)
