"""rule_match gains ``contains``, after ``prefix`` (spec 003 rules 3-3c).

A seed rule for ``income`` or ``transfer`` may match a run of whole tokens
anywhere in ``merchant_norm`` (``payroll`` in "sweetgreen inc payroll ppd id"),
for money-in transactions only. The check
``ck_category_rules_contains_is_seed_money_in`` keeps the kind to seed rows
for those two categories, so no user row (or direct write under RLS) can hold
one. It compares ``match::text``: a label added by ``ALTER TYPE ... ADD VALUE``
cannot be used as an enum value in the transaction that adds it.

Spec 003 rules 3b and 10 also stop rules and the model from giving money in a
spending category. Labels written before that (the dynamic sandbox user's
paycheck labeled ``dining`` by the seed rule ``sweetgreen``) are cleared here,
``rule`` and ``llm`` sources only, so the categorize run every sync queues
labels them again under the new rules. A user's own labels are kept. The
category list is spelled out (spec 007 rule 20's income and transfer buckets)
so this revision never changes when ``sync/categories.py`` does.

The downgrade deletes the ``contains`` rows (seed rows only; the next seed
load of the older code never writes them), drops the check and rebuilds the
type with its 0002 labels, as 0015_loan_account_kind does. Cleared labels stay
cleared; the older code's categorize run labels them its own way.

No new table or function: ``category_rules`` and ``transactions`` keep their
policies and grants.

Revision ID: 0016_rule_match_contains
Revises: 0015_loan_account_kind
Create Date: 2026-10-22
"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0016_rule_match_contains"
down_revision: str | None = "0015_loan_account_kind"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# rule_match as 0002_core created it.
OLD_RULE_MATCHES = ("exact", "prefix")
CHECK = "ck_category_rules_contains_is_seed_money_in"


def upgrade() -> None:
    op.execute("ALTER TYPE public.rule_match ADD VALUE IF NOT EXISTS 'contains' AFTER 'prefix'")
    op.execute(
        f"ALTER TABLE public.category_rules ADD CONSTRAINT {CHECK} CHECK ("
        "match::text <> 'contains'"
        " OR (user_id IS NULL AND category IN ('income', 'transfer')))"
    )
    op.execute(
        "UPDATE public.transactions"
        " SET category = NULL, category_source = NULL, confidence = NULL"
        " WHERE amount_cents < 0"
        " AND category NOT IN ('income', 'transfer')"
        " AND category_source::text IN ('rule', 'llm')"
    )


def downgrade() -> None:
    op.execute("DELETE FROM public.category_rules WHERE match::text = 'contains'")
    op.execute(f"ALTER TABLE public.category_rules DROP CONSTRAINT {CHECK}")
    op.execute("ALTER TYPE public.rule_match RENAME TO rule_match_0016")
    postgresql.ENUM(*OLD_RULE_MATCHES, name="rule_match").create(op.get_bind())
    op.execute(
        "ALTER TABLE public.category_rules ALTER COLUMN match TYPE public.rule_match"
        " USING match::text::public.rule_match"
    )
    op.execute("DROP TYPE public.rule_match_0016")
