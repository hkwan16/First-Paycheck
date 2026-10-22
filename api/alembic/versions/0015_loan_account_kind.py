"""account_kind gains ``loan``, after ``credit`` (spec 002 rule 4).

Plaid's ``loan`` accounts (auto, mortgage, student, home equity, line of
credit) were stored as ``credit``, so the net worth card called a mortgage a
credit card. A loan is a liability like a credit card (spec 015 rule 20); it
sorts beside ``credit`` so ``by_kind`` lists the liabilities together.

The upgrade changes no rows: a stored ``credit`` account cannot be told from a
loan here, and the next sync rewrites each account's kind (spec 002 rule 14).
Postgres adds an enum value in place; it cannot drop one, so the downgrade maps
loans back to ``credit`` and rebuilds the type with its 0002 labels, as
0011_no_model_reason does.

No new table or function: ``accounts`` keeps its owner policy and grants.

Revision ID: 0015_loan_account_kind
Revises: 0014_delete_account_fn
Create Date: 2026-10-22
"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0015_loan_account_kind"
down_revision: str | None = "0014_delete_account_fn"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# account_kind as 0002_core created it.
OLD_ACCOUNT_KINDS = ("checking", "savings", "credit", "investment", "retirement")


def upgrade() -> None:
    op.execute("ALTER TYPE public.account_kind ADD VALUE IF NOT EXISTS 'loan' AFTER 'credit'")


def downgrade() -> None:
    op.execute("UPDATE public.accounts SET kind = 'credit' WHERE kind::text = 'loan'")
    op.execute("ALTER TYPE public.account_kind RENAME TO account_kind_0015")
    postgresql.ENUM(*OLD_ACCOUNT_KINDS, name="account_kind").create(op.get_bind())
    op.execute(
        "ALTER TABLE public.accounts ALTER COLUMN kind TYPE public.account_kind"
        " USING kind::text::public.account_kind"
    )
    op.execute("DROP TYPE public.account_kind_0015")
