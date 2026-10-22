"""The ``plan.export`` job kind and ``plan_exports`` (spec 016 rules 14-17).

* ``job_kind`` gains ``plan.export``: the worker renders the plan PDF.
* ``jobs`` gains ``UNIQUE (id, user_id)``, the parent key of the same-user
  foreign key below (spec 001 rule 6).
* ``plan_exports`` holds the rendered PDF per job, owner policy with SELECT
  and INSERT only (the worker writes as the user; nobody edits an export).
  The scheduler deletes rows older than 7 days on the privileged connection
  (``export/store.py:expire_old``).

Postgres adds an enum value in place but cannot drop one, so the downgrade
drops the table, deletes ``plan.export`` jobs and rebuilds ``job_kind`` with
its earlier labels, as 0009_w4_calendar_kind does for ``calendar_kind``.

Revision ID: 0013_plan_export_job
Revises: 0009_w4_calendar_kind
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from db.rls import enable_rls

revision: str = "0013_plan_export_job"
down_revision: str | None = "0009_w4_calendar_kind"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_JOB_KIND = "plan.export"
# job_kind as 0002_core created it.
OLD_JOB_KINDS = (
    "sync.initial",
    "sync.incremental",
    "categorize.run",
    "ingest.extract",
    "recurring.detect",
    "checkin.monthly",
    "schedule.tick",
)


def upgrade() -> None:
    op.execute(f"ALTER TYPE public.job_kind ADD VALUE IF NOT EXISTS '{NEW_JOB_KIND}'")
    op.create_unique_constraint(op.f("uq_jobs_id_user_id"), "jobs", ["id", "user_id"])
    op.create_table(
        "plan_exports",
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("bytes", sa.LargeBinary(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("octet_length(bytes) > 0", name=op.f("ck_plan_exports_bytes_not_empty")),
        sa.CheckConstraint(
            "content_type = 'application/pdf'", name=op.f("ck_plan_exports_content_type_pdf")
        ),
        sa.ForeignKeyConstraint(
            ["job_id", "user_id"],
            ["jobs.id", "jobs.user_id"],
            name=op.f("fk_plan_exports_job_id_jobs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_plan_exports_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("job_id", name=op.f("pk_plan_exports")),
    )
    op.create_index("ix_plan_exports_created_at", "plan_exports", ["created_at"], unique=False)
    enable_rls("plan_exports", privileges=("SELECT", "INSERT"))


def downgrade() -> None:
    op.drop_index("ix_plan_exports_created_at", table_name="plan_exports")
    op.drop_table("plan_exports")
    op.drop_constraint(op.f("uq_jobs_id_user_id"), "jobs", type_="unique")
    op.execute("DELETE FROM public.jobs WHERE kind::text = 'plan.export'")
    op.execute("ALTER TYPE public.job_kind RENAME TO job_kind_0013")
    postgresql.ENUM(*OLD_JOB_KINDS, name="job_kind").create(op.get_bind())
    # The CHECK compares kind with a job_kind literal; it cannot be carried
    # across the type change, so it is dropped and created again as 0002 wrote it.
    op.drop_constraint(op.f("ck_jobs_system_jobs_have_no_owner"), "jobs", type_="check")
    op.execute(
        "ALTER TABLE public.jobs ALTER COLUMN kind TYPE public.job_kind"
        " USING kind::text::public.job_kind"
    )
    op.create_check_constraint(
        op.f("ck_jobs_system_jobs_have_no_owner"),
        "jobs",
        "(kind = 'schedule.tick') = (user_id IS NULL)",
    )
    op.execute("DROP TYPE public.job_kind_0013")
