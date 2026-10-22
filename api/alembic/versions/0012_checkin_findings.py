"""Finding keys and the done / dismissed actions (spec 015).

* ``check_in_findings.key``: what a finding reports (spec 015 rule 12), so a
  refresh updates the finding it already wrote instead of adding another, and
  a finding reported in one check-in is not reported again in the next.
  ``UNIQUE (check_in_id, key)`` holds one per check-in; ``(user_id, key)``
  serves the lookup across the user's other check-ins. Rows written before
  this revision get ``<kind>:<id>``, which no finder produces.
* ``finding_action`` becomes ``done``, ``dismissed``: the check-in screen
  offers exactly those two (and null to undo). Postgres cannot drop enum
  values, so the type is rebuilt; ``acknowledged`` and ``acted`` map to
  ``done``, and the downgrade maps ``done`` back to ``acted``.

No new table or function: ``check_in_findings`` keeps the owner policy and
grants of ``0005_checkins``, which cover the new column.

Revision ID: 0012_checkin_findings
Revises: 0009_w4_calendar_kind
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012_checkin_findings"
down_revision: str | None = "0009_w4_calendar_kind"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_ACTIONS = ("done", "dismissed")
OLD_ACTIONS = ("acknowledged", "acted", "dismissed")


def _rebuild_actions(labels: tuple[str, ...], mapping: str) -> None:
    """Recreate ``finding_action`` with ``labels``; ``mapping`` turns the old text into new."""
    op.execute("ALTER TYPE public.finding_action RENAME TO finding_action_old")
    values = ", ".join(f"'{label}'" for label in labels)
    op.execute(f"CREATE TYPE public.finding_action AS ENUM ({values})")
    op.execute(
        "ALTER TABLE public.check_in_findings ALTER COLUMN user_action TYPE public.finding_action"
        f" USING ({mapping})::public.finding_action"
    )
    op.execute("DROP TYPE public.finding_action_old")


def upgrade() -> None:
    op.add_column("check_in_findings", sa.Column("key", sa.Text(), nullable=True))
    op.execute("UPDATE public.check_in_findings SET key = kind::text || ':' || id::text")
    op.alter_column("check_in_findings", "key", nullable=False)
    op.create_check_constraint(
        op.f("ck_check_in_findings_key_not_empty"), "check_in_findings", "key <> ''"
    )
    op.create_unique_constraint(
        op.f("uq_check_in_findings_check_in_id_key"), "check_in_findings", ["check_in_id", "key"]
    )
    op.create_index("ix_check_in_findings_user_key", "check_in_findings", ["user_id", "key"])
    _rebuild_actions(
        NEW_ACTIONS,
        "CASE WHEN user_action IS NULL THEN NULL"
        " WHEN user_action::text = 'dismissed' THEN 'dismissed' ELSE 'done' END",
    )


def downgrade() -> None:
    _rebuild_actions(
        OLD_ACTIONS,
        "CASE user_action::text WHEN 'dismissed' THEN 'dismissed' WHEN 'done' THEN 'acted' END",
    )
    op.drop_index("ix_check_in_findings_user_key", table_name="check_in_findings")
    op.drop_constraint(
        op.f("uq_check_in_findings_check_in_id_key"), "check_in_findings", type_="unique"
    )
    op.drop_constraint(
        op.f("ck_check_in_findings_key_not_empty"), "check_in_findings", type_="check"
    )
    op.drop_column("check_in_findings", "key")
