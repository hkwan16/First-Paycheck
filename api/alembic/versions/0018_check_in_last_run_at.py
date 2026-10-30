"""check_ins.last_run_at: when the finders last ran on a check-in (spec 015
rule 9a, issue #171).

``updated_at`` moves only when the check-in's own row changes, so a refresh
that changed only its findings, or nothing, left it at the day the check-in
was made, and the screen said it was compared with the plan on that day right
after Check in now. Every run that creates or refreshes a check-in now sets
``last_run_at`` to the job's clock.

The column is ``NOT NULL`` with ``now()`` as its default; rows from before it
take their ``updated_at``, the latest time they are known to have run (with
the ``updated_at`` trigger off, so the backfill leaves ``updated_at`` alone).
No new table or function: ``check_ins`` keeps the owner policy and table
grants of ``0005_checkins``, which cover the new column. The downgrade drops
it.

Revision ID: 0018_check_in_last_run_at
Revises: 0017_document_replaced_by
Create Date: 2026-10-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018_check_in_last_run_at"
down_revision: str | None = "0017_document_replaced_by"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("check_ins", sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True))
    # The backfill must not look like a change: set_updated_at() would stamp
    # every row's updated_at with the migration's time.
    op.execute("ALTER TABLE public.check_ins DISABLE TRIGGER check_ins_set_updated_at")
    op.execute("UPDATE public.check_ins SET last_run_at = updated_at")
    op.execute("ALTER TABLE public.check_ins ENABLE TRIGGER check_ins_set_updated_at")
    op.alter_column("check_ins", "last_run_at", nullable=False, server_default=sa.text("now()"))


def downgrade() -> None:
    op.drop_column("check_ins", "last_run_at")
