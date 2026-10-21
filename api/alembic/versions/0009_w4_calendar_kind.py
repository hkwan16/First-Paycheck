"""calendar_kind gains ``w4_submit`` (spec 014 rule 18).

A saved W-4 decision reminds the user to give the employer the updated form
before the next paycheck. Postgres adds an enum value in place; it cannot drop
one, so the downgrade deletes those events and rebuilds the type with its
0008 labels, as 0008_goals_and_birth_year does.

No new table or function: ``calendar_events`` keeps its owner policy and grants.

Revision ID: 0009_w4_calendar_kind
Revises: 0011_no_model_reason
Create Date: 2026-10-21
"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009_w4_calendar_kind"
down_revision: str | None = "0011_no_model_reason"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_CALENDAR_KIND = "w4_submit"
# calendar_kind as 0008_goals_and_birth_year left it.
OLD_CALENDAR_KINDS = (
    "enrollment_deadline",
    "tax_season",
    "open_enrollment",
    "goal_target",
    "election_check",
    "goal_contribution",
    "goal_review",
)


def upgrade() -> None:
    op.execute(f"ALTER TYPE public.calendar_kind ADD VALUE IF NOT EXISTS '{NEW_CALENDAR_KIND}'")


def downgrade() -> None:
    op.execute("DELETE FROM public.calendar_events WHERE kind::text = 'w4_submit'")
    op.execute("ALTER TYPE public.calendar_kind RENAME TO calendar_kind_0009")
    postgresql.ENUM(*OLD_CALENDAR_KINDS, name="calendar_kind").create(op.get_bind())
    op.execute(
        "ALTER TABLE public.calendar_events ALTER COLUMN kind TYPE public.calendar_kind"
        " USING kind::text::public.calendar_kind"
    )
    op.execute("DROP TYPE public.calendar_kind_0009")
