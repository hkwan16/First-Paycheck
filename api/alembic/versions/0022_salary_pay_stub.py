"""profiles.salary_pay_stub_id: the stub the salary was last compared with
(spec 005 rule 24c, issue 221).

The profile's salary is a figure the person saved once; when a newer stub comes
to another yearly pay, ``GET /profile`` asks which to use. This column remembers
the stub the person answered for, so the same pay on the next paycheck, or a
second copy of the same stub, does not ask again.

* ``salary_pay_stub_id`` is nullable: null for every profile saved before this
  revision (asked once if the newest stub disagrees) and for a salary saved with
  no stub.
* ``(salary_pay_stub_id, user_id)`` references ``pay_stubs (id, user_id)``, so a
  profile only names one of the same user's stubs even on a connection that
  bypasses row-level security. ``ON DELETE SET NULL (salary_pay_stub_id)``:
  stubs are deleted only when ``auth.users`` cascades, and the column list
  keeps ``user_id``.

No new table, grant or function. The downgrade drops the column.

Revision ID: 0022_salary_pay_stub
Revises: 0021_paycheck_change
Create Date: 2026-11-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022_salary_pay_stub"
down_revision: str | None = "0021_paycheck_change"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("profiles", sa.Column("salary_pay_stub_id", sa.Uuid(), nullable=True))
    # SQLAlchemy cannot spell the Postgres 15 column list, so this foreign key is
    # written by hand (as 0004 writes goals'); the model declares it the same way.
    op.execute(
        "ALTER TABLE public.profiles ADD CONSTRAINT fk_profiles_salary_pay_stub_id_pay_stubs"
        " FOREIGN KEY (salary_pay_stub_id, user_id) REFERENCES public.pay_stubs (id, user_id)"
        " ON DELETE SET NULL (salary_pay_stub_id)"
    )


def downgrade() -> None:
    op.drop_constraint("fk_profiles_salary_pay_stub_id_pay_stubs", "profiles", type_="foreignkey")
    op.drop_column("profiles", "salary_pay_stub_id")
