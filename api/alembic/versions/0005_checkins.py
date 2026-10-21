"""Recurring charges, check-ins, findings and the deferred foreign keys (specs 001, 009).

* ``recurring_charges``: one row per detected (merchant, cadence), written by
  the ``recurring.detect`` job; the user renames it or sets ``user_status``.
* ``check_ins`` and ``check_in_findings``: the monthly review and its typed
  findings (filled in M8). One scheduled check-in per user and month.
* ``decisions.check_in_id`` and ``explanations.finding_id`` get the composite
  same-user foreign keys ``0004_decisions`` deferred. ``decisions.check_in_id``
  has no ON DELETE action: decisions are immutable, so a check-in a decision
  points at can only go with its owner's account, which removes both in one
  statement.

Every table has the owner policy with all privileges; this revision creates
no functions. Enum values are literal so the revision never changes when
``db/enums.py`` grows.

Revision ID: 0005_checkins
Revises: 0004_decisions
Create Date: 2026-11-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from db.rls import enable_rls

revision: str = "0005_checkins"
down_revision: str | None = "0004_decisions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ENUMS: dict[str, tuple[str, ...]] = {
    "recurring_cadence": ("weekly", "monthly", "yearly"),
    "recurring_status": ("active", "new", "changed", "stopped"),
    "recurring_user_status": ("confirmed", "ignored", "cancelled"),
    "checkin_trigger": ("schedule", "sync", "manual"),
    "checkin_status": ("open", "completed"),
    "finding_kind": (
        "election_mismatch",
        "goal_off_pace",
        "recurring_new",
        "recurring_changed",
        "recurring_stopped",
        "pay_change",
        "deduction_change",
        "upcoming_deadline",
    ),
    "finding_severity": ("info", "warning", "alert"),
    "finding_action": ("acknowledged", "acted", "dismissed"),
}

TABLES = ("recurring_charges", "check_ins", "check_in_findings")


def _timestamps() -> list[sa.Column[object]]:
    return [
        sa.Column(name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)
        for name in ("created_at", "updated_at")
    ]


def _enum(name: str) -> postgresql.ENUM:
    return postgresql.ENUM(*ENUMS[name], name=name, create_type=False)


def _owner_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["user_id"], ["auth.users.id"], name=op.f(f"fk_{table}_user_id_users"), ondelete="CASCADE"
    )


def upgrade() -> None:
    for name, values in ENUMS.items():
        postgresql.ENUM(*values, name=name).create(op.get_bind())
    _recurring_charges()
    _check_ins()
    _check_in_findings()
    for table in TABLES:
        op.execute(
            f"CREATE TRIGGER {table}_set_updated_at BEFORE UPDATE ON public.{table}"
            " FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()"
        )
        enable_rls(table)
    op.create_foreign_key(
        op.f("fk_decisions_check_in_id_check_ins"),
        "decisions",
        "check_ins",
        ["check_in_id", "user_id"],
        ["id", "user_id"],
    )
    op.create_foreign_key(
        op.f("fk_explanations_finding_id_check_in_findings"),
        "explanations",
        "check_in_findings",
        ["finding_id", "user_id"],
        ["id", "user_id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_explanations_finding_created",
        "explanations",
        ["finding_id", "created_at"],
        unique=False,
    )


def _recurring_charges() -> None:
    op.create_table(
        "recurring_charges",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("merchant_norm", sa.Text(), nullable=False),
        sa.Column("merchant_clean", sa.Text(), nullable=False),
        sa.Column("cadence", _enum("recurring_cadence"), nullable=False),
        sa.Column("typical_amount_cents", sa.BigInteger(), nullable=False),
        sa.Column("first_seen", sa.Date(), nullable=False),
        sa.Column("last_seen", sa.Date(), nullable=False),
        sa.Column(
            "status", _enum("recurring_status"), server_default=sa.text("'new'"), nullable=False
        ),
        sa.Column("user_status", _enum("recurring_user_status"), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "typical_amount_cents > 0", name=op.f("ck_recurring_charges_typical_positive")
        ),
        sa.CheckConstraint(
            "first_seen <= last_seen", name=op.f("ck_recurring_charges_seen_in_order")
        ),
        sa.CheckConstraint(
            "merchant_norm <> ''", name=op.f("ck_recurring_charges_merchant_norm_not_empty")
        ),
        sa.CheckConstraint(
            "merchant_clean <> ''", name=op.f("ck_recurring_charges_merchant_clean_not_empty")
        ),
        _owner_fk("recurring_charges"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recurring_charges")),
        sa.UniqueConstraint(
            "user_id",
            "merchant_norm",
            "cadence",
            name=op.f("uq_recurring_charges_user_id_merchant_norm_cadence"),
        ),
    )


def _check_ins() -> None:
    op.create_table(
        "check_ins",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("period", sa.Date(), nullable=False),
        sa.Column("triggered_by", _enum("checkin_trigger"), nullable=False),
        sa.Column(
            "status", _enum("checkin_status"), server_default=sa.text("'open'"), nullable=False
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "EXTRACT(day FROM period) = 1", name=op.f("ck_check_ins_period_first_of_month")
        ),
        sa.CheckConstraint(
            "(status = 'completed') = (completed_at IS NOT NULL)",
            name=op.f("ck_check_ins_completed_when_done"),
        ),
        _owner_fk("check_ins"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_check_ins")),
        sa.UniqueConstraint("id", "user_id", name=op.f("uq_check_ins_id_user_id")),
    )
    op.create_index(
        "uq_check_ins_scheduled_period",
        "check_ins",
        ["user_id", "period"],
        unique=True,
        postgresql_where=sa.text("triggered_by = 'schedule'"),
    )


def _check_in_findings() -> None:
    op.create_table(
        "check_in_findings",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("check_in_id", sa.Uuid(), nullable=False),
        sa.Column("kind", _enum("finding_kind"), nullable=False),
        sa.Column("severity", _enum("finding_severity"), nullable=False),
        sa.Column("decision_id", sa.Uuid(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("user_action", _enum("finding_action"), nullable=True),
        sa.Column("user_action_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "jsonb_typeof(payload) = 'object'", name=op.f("ck_check_in_findings_payload_object")
        ),
        sa.CheckConstraint(
            "(user_action IS NULL) = (user_action_at IS NULL)",
            name=op.f("ck_check_in_findings_action_has_time"),
        ),
        sa.ForeignKeyConstraint(
            ["check_in_id", "user_id"],
            ["check_ins.id", "check_ins.user_id"],
            name=op.f("fk_check_in_findings_check_in_id_check_ins"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["decision_id", "user_id"],
            ["decisions.id", "decisions.user_id"],
            name=op.f("fk_check_in_findings_decision_id_decisions"),
            ondelete="CASCADE",
        ),
        _owner_fk("check_in_findings"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_check_in_findings")),
        sa.UniqueConstraint("id", "user_id", name=op.f("uq_check_in_findings_id_user_id")),
    )
    op.create_index(
        "ix_check_in_findings_check_in_id", "check_in_findings", ["check_in_id"], unique=False
    )
    op.create_index(
        "ix_check_in_findings_decision_id", "check_in_findings", ["decision_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_explanations_finding_created", table_name="explanations")
    op.drop_constraint(
        op.f("fk_explanations_finding_id_check_in_findings"), "explanations", type_="foreignkey"
    )
    op.drop_constraint(op.f("fk_decisions_check_in_id_check_ins"), "decisions", type_="foreignkey")
    # Dropping a table drops its indexes, triggers and policies with it.
    for table in reversed(TABLES):
        op.drop_table(table)
    for name in reversed(ENUMS):
        postgresql.ENUM(name=name).drop(op.get_bind())
