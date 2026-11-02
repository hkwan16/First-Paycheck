"""pay_stubs.superseded_by_id: one current stub per paycheck (spec 005 rules
22a-22e, issue 190).

Before this revision, confirming the same pay stub again stored a second row
and every reader counted both (October read "2 pay stubs" at twice the gross).

* ``employer_key`` is generated from ``employer_name`` the way rule 22a
  compares employers (whitespace runs collapsed, trimmed, lowercased, a
  missing name as '').
* ``superseded_by_id`` is null while a stub is current, then the id of the
  stub that superseded it. ``(superseded_by_id, user_id)`` references
  ``pay_stubs (id, user_id)`` (hence ``UNIQUE (id, user_id)``), so a stub is
  only superseded by one of the same user's even on a connection that bypasses
  row-level security. The reference is DEFERRABLE INITIALLY DEFERRED: confirm
  marks the old row with the new row's id before inserting the new row, which
  the unique index below would refuse while the old one is current. NO ACTION
  on delete: rows are deleted only when ``auth.users`` cascades, which removes
  both ends in one statement.
* ``uq_pay_stubs_current_paycheck``: unique on ``(user_id, employer_key,
  pay_date, period_start, period_end) WHERE superseded_by_id IS NULL``.
* ``pay_stubs`` stays append-only for its values: ``authenticated`` gains
  ``UPDATE (superseded_by_id)`` only, and the ``pay_stubs_supersede_only``
  trigger refuses every update except setting a null ``superseded_by_id`` once
  with nothing else changed.

Stubs already stored are superseded as rule 22b would have done, in the order
they were confirmed (``created_at``, then ``id``), before the index is created,
so a user who confirmed copies keeps the newest one current (rule 22e).

The downgrade drops all of it; every copy then counts again.

Revision ID: 0020_pay_stub_superseded_by
Revises: 0019_explanation_context_digest
Create Date: 2026-11-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from db.rls import restrict_function

revision: str = "0020_pay_stub_superseded_by"
down_revision: str | None = "0019_explanation_context_digest"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMPLOYER_KEY = r"lower(btrim(regexp_replace(coalesce(employer_name, ''), '\s+', ' ', 'g')))"

# AFTER, not BEFORE: a BEFORE trigger sees the generated columns (tax_year,
# employer_key) of NEW as null, so the rows would never compare equal.
SUPERSEDE_ONLY = """
CREATE FUNCTION public.pay_stubs_supersede_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.superseded_by_id IS NULL
     AND NEW.superseded_by_id IS NOT NULL
     AND (to_jsonb(NEW) - 'superseded_by_id') = (to_jsonb(OLD) - 'superseded_by_id') THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'a confirmed pay stub never changes: it is only superseded, once'
    USING ERRCODE = 'restrict_violation';
END
$$
"""

# Rule 22b over the stubs already stored, one stub at a time in confirm order:
# each supersedes the earlier current stubs of its paycheck and of the
# documents its document replaced (directly or along a chain).
BACKFILL = """
DO $$
DECLARE
  s record;
BEGIN
  FOR s IN SELECT id, user_id, document_id, employer_key, pay_date, period_start,
                  period_end, created_at
           FROM public.pay_stubs ORDER BY created_at, id
  LOOP
    WITH RECURSIVE replaced(id) AS (
      SELECT d.id FROM public.documents d WHERE d.replaced_by_id = s.document_id
      UNION
      SELECT d.id FROM public.documents d JOIN replaced r ON d.replaced_by_id = r.id
    )
    UPDATE public.pay_stubs p SET superseded_by_id = s.id
    WHERE p.user_id = s.user_id
      AND p.superseded_by_id IS NULL
      AND p.id <> s.id
      AND (p.created_at, p.id) < (s.created_at, s.id)
      AND (
        (p.employer_key, p.pay_date, p.period_start, p.period_end)
          = (s.employer_key, s.pay_date, s.period_start, s.period_end)
        OR p.document_id IN (SELECT id FROM replaced)
      );
  END LOOP;
END
$$
"""


def upgrade() -> None:
    op.add_column(
        "pay_stubs",
        sa.Column(
            "employer_key",
            sa.Text(),
            sa.Computed(EMPLOYER_KEY, persisted=True),
            nullable=False,
        ),
    )
    op.add_column("pay_stubs", sa.Column("superseded_by_id", sa.Uuid(), nullable=True))
    op.create_unique_constraint(op.f("uq_pay_stubs_id_user_id"), "pay_stubs", ["id", "user_id"])
    # Before the deferred reference and the trigger exist: their pending events
    # would keep CREATE INDEX from running in this transaction. Adding the
    # reference afterwards checks every row the backfill wrote.
    op.execute(BACKFILL)
    op.create_foreign_key(
        "fk_pay_stubs_superseded_by_id_pay_stubs",
        "pay_stubs",
        "pay_stubs",
        ["superseded_by_id", "user_id"],
        ["id", "user_id"],
        deferrable=True,
        initially="DEFERRED",
    )
    op.create_check_constraint(
        op.f("ck_pay_stubs_superseded_by_other"), "pay_stubs", "superseded_by_id <> id"
    )
    op.execute(SUPERSEDE_ONLY)
    restrict_function("pay_stubs_supersede_only()")
    op.execute(
        "CREATE TRIGGER pay_stubs_supersede_only AFTER UPDATE ON public.pay_stubs"
        " FOR EACH ROW EXECUTE FUNCTION public.pay_stubs_supersede_only()"
    )
    op.create_index(
        "uq_pay_stubs_current_paycheck",
        "pay_stubs",
        ["user_id", "employer_key", "pay_date", "period_start", "period_end"],
        unique=True,
        postgresql_where=sa.text("superseded_by_id IS NULL"),
    )
    op.execute("GRANT UPDATE (superseded_by_id) ON public.pay_stubs TO authenticated")


def downgrade() -> None:
    op.execute("REVOKE UPDATE (superseded_by_id) ON public.pay_stubs FROM authenticated")
    op.drop_index("uq_pay_stubs_current_paycheck", table_name="pay_stubs")
    op.execute("DROP TRIGGER pay_stubs_supersede_only ON public.pay_stubs")
    op.execute("DROP FUNCTION public.pay_stubs_supersede_only()")
    op.drop_constraint(op.f("ck_pay_stubs_superseded_by_other"), "pay_stubs", type_="check")
    op.drop_constraint("fk_pay_stubs_superseded_by_id_pay_stubs", "pay_stubs", type_="foreignkey")
    op.drop_constraint(op.f("uq_pay_stubs_id_user_id"), "pay_stubs", type_="unique")
    op.drop_column("pay_stubs", "superseded_by_id")
    op.drop_column("pay_stubs", "employer_key")
