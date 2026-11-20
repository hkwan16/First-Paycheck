"""The person's day: profiles.time_zone and check_ins.as_of (spec 019, issue 232).

Every date the app derives from the clock now comes from the person's IANA
zone, which the browser reports and ``profiles.time_zone`` stores (null until
then, read as the default zone). Which names are zones is checked by the route
against the tz database; the column only checks the length.

``check_ins.as_of`` stores the date each run judged its check-in as of (rule
11), so a later change of zone never moves a record's date (rule 12). Rows
from before it take what ``GET /check-ins`` showed for them, the UTC date of
``last_run_at`` capped at the month's last day (and kept within the month),
with the ``updated_at`` trigger off so the backfill leaves ``updated_at``
alone; then the column is ``NOT NULL`` with a check that it lies in its month.
No new table or function: both tables keep their owner policies and grants,
which cover the new columns. The downgrade drops both columns.

Revision ID: 0026_the_persons_day
Revises: 0025_account_role_fits_kind
Create Date: 2026-11-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026_the_persons_day"
down_revision: str | None = "0025_account_role_fits_kind"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("profiles", sa.Column("time_zone", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_profiles_time_zone_length", "profiles", "char_length(time_zone) BETWEEN 1 AND 64"
    )

    op.add_column("check_ins", sa.Column("as_of", sa.Date(), nullable=True))
    op.execute("ALTER TABLE public.check_ins DISABLE TRIGGER check_ins_set_updated_at")
    op.execute(
        "UPDATE public.check_ins SET as_of = greatest("
        " period,"
        " least("
        "  (last_run_at AT TIME ZONE 'UTC')::date,"
        "  (period + interval '1 month' - interval '1 day')::date))"
    )
    op.execute("ALTER TABLE public.check_ins ENABLE TRIGGER check_ins_set_updated_at")
    op.alter_column("check_ins", "as_of", nullable=False)
    op.create_check_constraint(
        "ck_check_ins_as_of_in_period",
        "check_ins",
        "as_of >= period AND as_of < period + interval '1 month'",
    )


def downgrade() -> None:
    op.drop_constraint("ck_check_ins_as_of_in_period", "check_ins", type_="check")
    op.drop_column("check_ins", "as_of")
    op.drop_constraint("ck_profiles_time_zone_length", "profiles", type_="check")
    op.drop_column("profiles", "time_zone")
