"""Goal status, one emergency fund per user, goal calendar kinds and the birth year
(specs 011 and 006).

* ``goals.status`` (``goal_status``: active, paused, reached) and
  ``goals.reached_at``, set together; ``PATCH /goals/{id}`` writes them.
* ``uq_goals_user_emergency_fund``: a saved emergency-fund decision creates or
  updates the user's one emergency-fund goal.
* ``calendar_kind`` gains ``goal_contribution`` and ``goal_review``. Postgres
  cannot drop an enum value, so the downgrade deletes those events and
  rebuilds the type with its 0004 labels.
* ``benefits_plans.position`` keeps a summary's plans in the order it lists
  them (spec 013 rule 14); existing rows are numbered by ``created_at, id``.
* ``profiles.birth_year`` settles spec 006 open question 2. The lower bound is
  a CHECK; the upper bound (the current year) is the route's, because a CHECK
  cannot read the clock.

No new table or function: ``goals``, ``calendar_events``, ``benefits_plans`` and
``profiles`` keep
the owner policies and grants their own migrations gave them.

Revision ID: 0008_goals_and_birth_year
Revises: 0005_checkins
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008_goals_and_birth_year"
down_revision: str | None = "0005_checkins"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

GOAL_STATUS = ("active", "paused", "reached")
NEW_CALENDAR_KINDS = ("goal_contribution", "goal_review")
# calendar_kind as 0004_decisions created it.
OLD_CALENDAR_KINDS = (
    "enrollment_deadline",
    "tax_season",
    "open_enrollment",
    "goal_target",
    "election_check",
)


def upgrade() -> None:
    postgresql.ENUM(*GOAL_STATUS, name="goal_status").create(op.get_bind())
    op.add_column(
        "goals",
        sa.Column(
            "status",
            postgresql.ENUM(*GOAL_STATUS, name="goal_status", create_type=False),
            server_default=sa.text("'active'"),
            nullable=False,
        ),
    )
    op.add_column("goals", sa.Column("reached_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        op.f("ck_goals_reached_has_time"),
        "goals",
        "(status = 'reached') = (reached_at IS NOT NULL)",
    )
    op.create_index(
        "uq_goals_user_emergency_fund",
        "goals",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'emergency_fund'"),
    )
    for label in NEW_CALENDAR_KINDS:
        op.execute(f"ALTER TYPE public.calendar_kind ADD VALUE IF NOT EXISTS '{label}'")
    op.add_column("profiles", sa.Column("birth_year", sa.SmallInteger(), nullable=True))
    op.create_check_constraint(
        op.f("ck_profiles_birth_year_after_1900"), "profiles", "birth_year >= 1900"
    )
    op.add_column(
        "benefits_plans",
        sa.Column("position", sa.SmallInteger(), server_default=sa.text("0"), nullable=False),
    )
    op.execute(
        "UPDATE benefits_plans AS plan SET position = numbered.position"
        " FROM (SELECT id, row_number() OVER"
        " (PARTITION BY document_id ORDER BY created_at, id) - 1 AS position"
        " FROM benefits_plans WHERE document_id IS NOT NULL) AS numbered"
        " WHERE plan.id = numbered.id"
    )
    op.create_check_constraint(
        op.f("ck_benefits_plans_position_non_negative"), "benefits_plans", "position >= 0"
    )
    op.create_index(
        "uq_benefits_plans_document_position",
        "benefits_plans",
        ["document_id", "position"],
        unique=True,
        postgresql_where=sa.text("document_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_benefits_plans_document_position", table_name="benefits_plans")
    op.drop_constraint(
        op.f("ck_benefits_plans_position_non_negative"), "benefits_plans", type_="check"
    )
    op.drop_column("benefits_plans", "position")
    op.drop_constraint(op.f("ck_profiles_birth_year_after_1900"), "profiles", type_="check")
    op.drop_column("profiles", "birth_year")
    op.execute(
        "DELETE FROM public.calendar_events"
        " WHERE kind::text IN ('goal_contribution', 'goal_review')"
    )
    op.execute("ALTER TYPE public.calendar_kind RENAME TO calendar_kind_0008")
    postgresql.ENUM(*OLD_CALENDAR_KINDS, name="calendar_kind").create(op.get_bind())
    op.execute(
        "ALTER TABLE public.calendar_events ALTER COLUMN kind TYPE public.calendar_kind"
        " USING kind::text::public.calendar_kind"
    )
    op.execute("DROP TYPE public.calendar_kind_0008")
    op.drop_index("uq_goals_user_emergency_fund", table_name="goals")
    op.drop_constraint(op.f("ck_goals_reached_has_time"), "goals", type_="check")
    op.drop_column("goals", "reached_at")
    op.drop_column("goals", "status")
    postgresql.ENUM(name="goal_status").drop(op.get_bind())
