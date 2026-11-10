"""ck_accounts_role_fits_kind: each account kind takes only the roles that
describe it (spec 002 rule 31a, issue 241).

| Kind | Roles |
|---|---|
| checking | spending, emergency_fund |
| savings | emergency_fund |
| credit | spending |
| loan | none |
| investment | retirement |
| retirement | retirement |

Before this revision the Link screen offered every role to every kind, so a
loan could be marked the emergency fund (whose balance the emergency fund card
reads as savings). The upgrade first clears every role its account's kind does
not allow, then adds the check. ``db/enums.py`` ``ROLES_BY_KIND`` is the same
table; this text is a snapshot of it, as a migration must be.

No new table or function. The downgrade drops the check; cleared roles stay
cleared (nothing records what they were, and none of them was allowed).

Revision ID: 0023_account_role_fits_kind
Revises: 0022_document_review_draft
Create Date: 2026-11-09
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0023_account_role_fits_kind"
down_revision: str | None = "0022_document_review_draft"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ROLE_FITS_KIND = (
    "role IS NULL"
    " OR (kind = 'checking' AND role IN ('spending', 'emergency_fund'))"
    " OR (kind = 'savings' AND role IN ('emergency_fund'))"
    " OR (kind = 'credit' AND role IN ('spending'))"
    " OR (kind = 'investment' AND role IN ('retirement'))"
    " OR (kind = 'retirement' AND role IN ('retirement'))"
)


def upgrade() -> None:
    # Every role ROLE_FITS_KIND does not allow, written out: a migration's SQL is literal.
    op.execute(
        "UPDATE accounts SET role = NULL WHERE NOT ("
        "(kind = 'checking' AND role IN ('spending', 'emergency_fund'))"
        " OR (kind = 'savings' AND role IN ('emergency_fund'))"
        " OR (kind = 'credit' AND role IN ('spending'))"
        " OR (kind = 'investment' AND role IN ('retirement'))"
        " OR (kind = 'retirement' AND role IN ('retirement')))"
    )
    op.create_check_constraint(op.f("ck_accounts_role_fits_kind"), "accounts", ROLE_FITS_KIND)


def downgrade() -> None:
    op.drop_constraint(op.f("ck_accounts_role_fits_kind"), "accounts", type_="check")
