"""Decisions, goals, calendar events, explanations and IRS citations (specs 001, 007, 008).

* ``decisions``: append-only and versioned. SELECT and INSERT only; the insert
  policy also checks that a superseded row belongs to the user; an insert
  trigger checks the parent's calculator and version; an immutability trigger
  rejects every UPDATE and every DELETE except the cascade from deleting the
  owner's ``auth.users`` row (spec 007 rule 9). ``current_decisions`` is a
  security-invoker view of the rows nothing supersedes.
* ``goals`` and ``calendar_events``: the owner policy with every privilege.
* ``explanations``: append-only (SELECT, INSERT). ``created_at`` defaults to
  ``clock_timestamp()`` so the attempts of one run keep their order.
* ``irs_citations``: reference data without an owner, readable by every
  signed-in user and written only by the seed loader.

Children of a decision cascade on delete; a decision is deleted only with its
owner's account. ``decisions.check_in_id`` and ``explanations.finding_id``
get their foreign keys in ``0005_checkins``. Enum values are literal so this
revision never changes when ``db/enums.py`` grows.

Revision ID: 0004_decisions
Revises: 0003_documents
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from db.rls import enable_rls

revision: str = "0004_decisions"
down_revision: str | None = "0003_documents"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ENUMS: dict[str, tuple[str, ...]] = {
    "calculator_kind": ("emergency_fund", "k401_match", "health_plans", "w4"),
    "goal_kind": ("emergency_fund", "custom"),
    "calendar_kind": (
        "enrollment_deadline",
        "tax_season",
        "open_enrollment",
        "goal_target",
        "election_check",
    ),
    "calendar_status": ("upcoming", "done", "dismissed"),
}

OWNER = "(SELECT public.current_user_id())"

CHECK_PARENT = """
CREATE FUNCTION public.decisions_check_parent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent record;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT user_id, calculator, version INTO parent
  FROM public.decisions WHERE id = NEW.supersedes_id;
  IF NOT FOUND
     OR parent.user_id <> NEW.user_id
     OR parent.calculator <> NEW.calculator
     OR parent.version <> NEW.version - 1 THEN
    RAISE EXCEPTION 'decision version % must supersede version % of the same calculator',
      NEW.version, NEW.version - 1
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$
"""

# SECURITY DEFINER so the auth.users lookup runs as the migration role, which
# can read it, whoever deletes the user. It reads one row's existence by id.
IMMUTABLE = """
CREATE FUNCTION public.decisions_immutable() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    -- Issued by another trigger: allowed only as the cascade from deleting
    -- the owner's account, after which the auth.users row is gone.
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'decisions are immutable: save a new version instead'
    USING ERRCODE = 'restrict_violation';
END
$$
"""

# The insert policy's ownership check on the superseded row. A subquery on
# decisions inside a decisions policy is rejected as recursive, so the check
# is a PL/pgSQL function (never inlined): its query runs on its own, as the
# calling user, under the select policy.
DECISION_IS_MINE = """
CREATE FUNCTION public.decision_is_mine(p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.decisions WHERE id = p_id AND user_id = public.current_user_id()
  );
END
$$
"""

CURRENT_DECISIONS = """
CREATE VIEW public.current_decisions WITH (security_invoker = true) AS
SELECT d.*
FROM public.decisions d
WHERE NOT EXISTS (
  SELECT 1 FROM public.decisions successor WHERE successor.supersedes_id = d.id
)
"""


def _created_at(default: str = "now()") -> sa.Column[object]:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.text(default), nullable=False
    )


def _updated_at() -> sa.Column[object]:
    return sa.Column(
        "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _enum(name: str) -> postgresql.ENUM:
    return postgresql.ENUM(*ENUMS[name], name=name, create_type=False)


def _owner_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["user_id"], ["auth.users.id"], name=op.f(f"fk_{table}_user_id_users"), ondelete="CASCADE"
    )


def _decision_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["decision_id", "user_id"],
        ["decisions.id", "decisions.user_id"],
        name=op.f(f"fk_{table}_decision_id_decisions"),
        ondelete="CASCADE",
    )


def upgrade() -> None:
    for name, values in ENUMS.items():
        postgresql.ENUM(*values, name=name).create(op.get_bind())
    _decisions()
    _goals()
    _calendar_events()
    _explanations()
    _irs_citations()
    for table in ("goals", "calendar_events", "irs_citations"):
        op.execute(
            f"CREATE TRIGGER {table}_set_updated_at BEFORE UPDATE ON public.{table}"
            " FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()"
        )
    enable_rls("goals")
    enable_rls("calendar_events")
    enable_rls("explanations", privileges=("SELECT", "INSERT"))


def _decisions() -> None:
    op.create_table(
        "decisions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("calculator", _enum("calculator_kind"), nullable=False),
        sa.Column("inputs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("supersedes_id", sa.Uuid(), nullable=True),
        sa.Column("check_in_id", sa.Uuid(), nullable=True),
        _created_at(),
        sa.CheckConstraint("version >= 1", name=op.f("ck_decisions_version_positive")),
        sa.CheckConstraint(
            "(version = 1) = (supersedes_id IS NULL)",
            name=op.f("ck_decisions_first_version_has_no_parent"),
        ),
        sa.CheckConstraint(
            "jsonb_typeof(inputs) = 'object'", name=op.f("ck_decisions_inputs_object")
        ),
        sa.CheckConstraint(
            "jsonb_typeof(result) = 'object'", name=op.f("ck_decisions_result_object")
        ),
        sa.ForeignKeyConstraint(
            ["supersedes_id", "user_id"],
            ["decisions.id", "decisions.user_id"],
            name=op.f("fk_decisions_supersedes_id_decisions"),
            ondelete="CASCADE",
        ),
        _owner_fk("decisions"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_decisions")),
        sa.UniqueConstraint("id", "user_id", name=op.f("uq_decisions_id_user_id")),
        sa.UniqueConstraint(
            "user_id", "calculator", "version", name=op.f("uq_decisions_user_id_calculator_version")
        ),
    )
    op.create_index(
        "uq_decisions_supersedes_id",
        "decisions",
        ["supersedes_id"],
        unique=True,
        postgresql_where=sa.text("supersedes_id IS NOT NULL"),
    )
    op.execute(CHECK_PARENT)
    op.execute(
        "CREATE TRIGGER decisions_check_parent BEFORE INSERT ON public.decisions"
        " FOR EACH ROW EXECUTE FUNCTION public.decisions_check_parent()"
    )
    op.execute(IMMUTABLE)
    op.execute("REVOKE ALL ON FUNCTION public.decisions_immutable() FROM PUBLIC")
    op.execute(
        "CREATE TRIGGER decisions_immutable BEFORE UPDATE OR DELETE ON public.decisions"
        " FOR EACH ROW EXECUTE FUNCTION public.decisions_immutable()"
    )
    op.execute(DECISION_IS_MINE)
    op.execute("REVOKE ALL ON FUNCTION public.decision_is_mine(uuid) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION public.decision_is_mine(uuid) TO authenticated")
    op.execute("ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.decisions FORCE ROW LEVEL SECURITY")
    op.execute("REVOKE ALL ON public.decisions FROM PUBLIC, anon, authenticated")
    op.execute(
        "CREATE POLICY decisions_select ON public.decisions AS PERMISSIVE FOR SELECT"
        f" TO authenticated USING (user_id = {OWNER})"
    )
    op.execute(
        "CREATE POLICY decisions_insert ON public.decisions AS PERMISSIVE FOR INSERT"
        f" TO authenticated WITH CHECK (user_id = {OWNER}"
        " AND (supersedes_id IS NULL OR public.decision_is_mine(supersedes_id)))"
    )
    op.execute("GRANT SELECT, INSERT ON public.decisions TO authenticated")
    op.execute(CURRENT_DECISIONS)
    op.execute("REVOKE ALL ON public.current_decisions FROM PUBLIC, anon, authenticated")
    op.execute("GRANT SELECT ON public.current_decisions TO authenticated")


def _goals() -> None:
    op.create_table(
        "goals",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", _enum("goal_kind"), nullable=False),
        sa.Column("target_amount_cents", sa.BigInteger(), nullable=False),
        sa.Column("monthly_contribution_cents", sa.BigInteger(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=True),
        sa.Column("decision_id", sa.Uuid(), nullable=True),
        sa.Column("target_date", sa.Date(), nullable=True),
        _created_at(),
        _updated_at(),
        sa.CheckConstraint("target_amount_cents > 0", name=op.f("ck_goals_target_positive")),
        sa.CheckConstraint(
            "monthly_contribution_cents >= 0", name=op.f("ck_goals_contribution_non_negative")
        ),
        _decision_fk("goals"),
        _owner_fk("goals"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goals")),
    )
    # Unlinking an account keeps the goal and clears only account_id (spec 001
    # rule 25). SQLAlchemy cannot spell the Postgres 15 column list, so this
    # foreign key is written by hand; the model declares it as SET NULL.
    op.execute(
        "ALTER TABLE public.goals ADD CONSTRAINT fk_goals_account_id_accounts"
        " FOREIGN KEY (account_id, user_id) REFERENCES public.accounts (id, user_id)"
        " ON DELETE SET NULL (account_id)"
    )
    op.create_index("ix_goals_user_id", "goals", ["user_id"], unique=False)


def _calendar_events() -> None:
    op.create_table(
        "calendar_events",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", _enum("calendar_kind"), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("due_at", sa.Date(), nullable=False),
        sa.Column("decision_id", sa.Uuid(), nullable=True),
        sa.Column(
            "status",
            _enum("calendar_status"),
            server_default=sa.text("'upcoming'"),
            nullable=False,
        ),
        _created_at(),
        _updated_at(),
        sa.CheckConstraint("title <> ''", name=op.f("ck_calendar_events_title_not_empty")),
        _decision_fk("calendar_events"),
        _owner_fk("calendar_events"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_calendar_events")),
    )
    op.create_index(
        "ix_calendar_events_user_due", "calendar_events", ["user_id", "due_at"], unique=False
    )
    op.create_index(
        "ix_calendar_events_decision_id", "calendar_events", ["decision_id"], unique=False
    )


def _explanations() -> None:
    op.create_table(
        "explanations",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("decision_id", sa.Uuid(), nullable=True),
        sa.Column("finding_id", sa.Uuid(), nullable=True),
        sa.Column("attempt", sa.SmallInteger(), nullable=False),
        sa.Column("retries", sa.SmallInteger(), nullable=False),
        sa.Column("concept", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column(
            "numbers",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "what_ifs",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "citations",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("verified", sa.Boolean(), nullable=False),
        sa.Column("fallback", sa.Boolean(), nullable=False),
        sa.Column(
            "verification",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        _created_at("clock_timestamp()"),
        sa.CheckConstraint(
            "num_nonnulls(decision_id, finding_id) = 1", name=op.f("ck_explanations_one_subject")
        ),
        sa.CheckConstraint("attempt BETWEEN 1 AND 3", name=op.f("ck_explanations_attempt_range")),
        sa.CheckConstraint("retries IN (0, 1)", name=op.f("ck_explanations_retries_range")),
        sa.CheckConstraint(
            "NOT (verified AND fallback)", name=op.f("ck_explanations_verified_or_fallback")
        ),
        sa.CheckConstraint(
            "jsonb_typeof(numbers) = 'array'", name=op.f("ck_explanations_numbers_array")
        ),
        sa.CheckConstraint(
            "jsonb_typeof(what_ifs) = 'array'", name=op.f("ck_explanations_what_ifs_array")
        ),
        sa.CheckConstraint(
            "jsonb_typeof(citations) = 'array'", name=op.f("ck_explanations_citations_array")
        ),
        sa.CheckConstraint(
            "jsonb_typeof(verification) = 'object'",
            name=op.f("ck_explanations_verification_object"),
        ),
        _decision_fk("explanations"),
        _owner_fk("explanations"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_explanations")),
    )
    op.create_index(
        "ix_explanations_decision_created",
        "explanations",
        ["decision_id", "created_at"],
        unique=False,
    )


def _irs_citations() -> None:
    op.create_table(
        "irs_citations",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("calculator", _enum("calculator_kind"), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("passage", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("tax_year", sa.SmallInteger(), nullable=False),
        sa.Column("verified_on", sa.Date(), nullable=False),
        _created_at(),
        _updated_at(),
        sa.CheckConstraint("url LIKE 'https://%'", name=op.f("ck_irs_citations_url_https")),
        sa.CheckConstraint("key <> ''", name=op.f("ck_irs_citations_key_not_empty")),
        sa.CheckConstraint("passage <> ''", name=op.f("ck_irs_citations_passage_not_empty")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_irs_citations")),
        sa.UniqueConstraint(
            "calculator", "key", "tax_year", name=op.f("uq_irs_citations_calculator_key_tax_year")
        ),
    )
    op.execute("ALTER TABLE public.irs_citations ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.irs_citations FORCE ROW LEVEL SECURITY")
    op.execute("REVOKE ALL ON public.irs_citations FROM PUBLIC, anon, authenticated")
    op.execute(
        "CREATE POLICY irs_citations_read ON public.irs_citations AS PERMISSIVE FOR SELECT"
        " TO authenticated USING (true)"
    )
    op.execute("GRANT SELECT ON public.irs_citations TO authenticated")


def downgrade() -> None:
    op.execute("DROP VIEW public.current_decisions")
    # Dropping a table drops its indexes, triggers and policies with it.
    for table in ("irs_citations", "explanations", "calendar_events", "goals", "decisions"):
        op.drop_table(table)
    op.execute("DROP FUNCTION public.decision_is_mine(uuid)")
    op.execute("DROP FUNCTION public.decisions_immutable()")
    op.execute("DROP FUNCTION public.decisions_check_parent()")
    for name in reversed(ENUMS):
        postgresql.ENUM(name=name).drop(op.get_bind())
