"""Core tables: profiles, sync items, accounts, transactions, balances,
holdings, category rules, jobs and the LLM cost ledger (spec 001).

Row-level security follows spec 001: every table gets the owner policy from
``db.rls.enable_rls``, with grants trimmed per table, plus two exceptions:

* ``category_rules``: an extra SELECT policy shows seed rows (``user_id IS
  NULL``) to every user; writes still need ``user_id = auth.uid()``, so seed
  rows are written only by the seed loader on the privileged connection.
* ``jobs``: SELECT and INSERT only. Dequeue, progress, heartbeat and
  completion run in ``jobs/queue.py`` on the privileged connection.

``set_updated_at()`` is created here (spec 001 lists it under 0001, which
never created it) and maintains ``updated_at`` on every mutable table.

Enum values are written out literally so this revision never changes when
``db/enums.py`` grows; adding a value is a new migration.

Revision ID: 0002_core
Revises: 0001_roles
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from db.rls import enable_rls

revision: str = "0002_core"
down_revision: str | None = "0001_roles"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ENUMS: dict[str, tuple[str, ...]] = {
    "pay_frequency": ("weekly", "biweekly", "semimonthly", "monthly"),
    "filing_status": ("single", "married_filing_jointly", "head_of_household"),
    "healthcare_usage": ("low", "medium", "high"),
    "sync_provider": ("plaid", "csv"),
    "sync_status": ("active", "login_required", "error"),
    "account_kind": ("checking", "savings", "credit", "investment", "retirement"),
    "account_role": ("spending", "emergency_fund", "retirement"),
    "category_source": ("rule", "user", "llm"),
    "rule_match": ("exact", "prefix"),
    "rule_source": ("seed", "user"),
    "job_kind": (
        "sync.initial",
        "sync.incremental",
        "categorize.run",
        "ingest.extract",
        "recurring.detect",
        "checkin.monthly",
        "schedule.tick",
    ),
    "job_status": ("queued", "running", "succeeded", "dead"),
    "llm_purpose": ("extract", "categorize", "explain"),
    "llm_status": ("ok", "refusal", "schema_error", "api_error", "budget_blocked"),
}

SET_UPDATED_AT = """
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$
"""

UPDATED_AT_TABLES = (
    "profiles",
    "sync_items",
    "accounts",
    "transactions",
    "holdings",
    "category_rules",
    "jobs",
)

# Grants per table under the owner policy. Append-only tables get no UPDATE;
# children of sync_items are deleted by ON DELETE CASCADE, which needs no grant.
PRIVILEGES: dict[str, tuple[str, ...]] = {
    "profiles": ("SELECT", "INSERT", "UPDATE"),
    "sync_items": ("SELECT", "INSERT", "UPDATE", "DELETE"),
    "accounts": ("SELECT", "INSERT", "UPDATE"),
    "transactions": ("SELECT", "INSERT", "UPDATE", "DELETE"),
    "balance_snapshots": ("SELECT", "INSERT"),
    "holdings": ("SELECT", "INSERT", "UPDATE", "DELETE"),
    "category_rules": ("SELECT", "INSERT", "UPDATE", "DELETE"),
    "jobs": ("SELECT", "INSERT"),
    "llm_calls": ("SELECT", "INSERT"),
}


def _row_level_security() -> None:
    for table, privileges in PRIVILEGES.items():
        enable_rls(table, privileges=privileges)
    op.execute(
        "CREATE POLICY category_rules_seed_read ON public.category_rules AS PERMISSIVE"
        " FOR SELECT TO authenticated USING (user_id IS NULL)"
    )


def upgrade() -> None:
    for name, values in ENUMS.items():
        postgresql.ENUM(*values, name=name).create(op.get_bind())
    op.execute(SET_UPDATED_AT)

    op.create_table(
        "category_rules",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("merchant_norm", sa.Text(), nullable=False),
        sa.Column(
            "match",
            postgresql.ENUM("exact", "prefix", name="rule_match", create_type=False),
            nullable=False,
        ),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column(
            "source",
            postgresql.ENUM("seed", "user", name="rule_source", create_type=False),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(user_id IS NULL) = (source = 'seed')",
            name=op.f("ck_category_rules_seed_rows_have_no_owner"),
        ),
        sa.CheckConstraint(
            "merchant_norm <> ''", name=op.f("ck_category_rules_merchant_norm_not_empty")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_category_rules_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_category_rules")),
        sa.UniqueConstraint(
            "user_id",
            "merchant_norm",
            "match",
            name=op.f("uq_category_rules_user_id_merchant_norm_match"),
            postgresql_nulls_not_distinct=True,
        ),
    )
    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column(
            "kind",
            postgresql.ENUM(
                "sync.initial",
                "sync.incremental",
                "categorize.run",
                "ingest.extract",
                "recurring.detect",
                "checkin.monthly",
                "schedule.tick",
                name="job_kind",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column(
            "status",
            postgresql.ENUM(
                "queued", "running", "succeeded", "dead", name="job_status", create_type=False
            ),
            server_default=sa.text("'queued'"),
            nullable=False,
        ),
        sa.Column("progress", sa.SmallInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("attempts", sa.SmallInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "run_after", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(kind = 'schedule.tick') = (user_id IS NULL)",
            name=op.f("ck_jobs_system_jobs_have_no_owner"),
        ),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_jobs_attempts_non_negative")),
        sa.CheckConstraint("progress BETWEEN 0 AND 100", name=op.f("ck_jobs_progress_range")),
        sa.ForeignKeyConstraint(
            ["user_id"], ["auth.users.id"], name=op.f("fk_jobs_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_jobs")),
    )
    op.create_index(
        "ix_jobs_queued_run_after",
        "jobs",
        ["run_after"],
        unique=False,
        postgresql_where=sa.text("status = 'queued'"),
    )
    op.create_index(
        "ix_jobs_running_heartbeat",
        "jobs",
        ["heartbeat_at"],
        unique=False,
        postgresql_where=sa.text("status = 'running'"),
    )
    op.create_index(
        "uq_jobs_idempotency_key",
        "jobs",
        ["user_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )
    op.create_table(
        "profiles",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("salary_cents", sa.BigInteger(), nullable=True),
        sa.Column(
            "pay_frequency",
            postgresql.ENUM(
                "weekly",
                "biweekly",
                "semimonthly",
                "monthly",
                name="pay_frequency",
                create_type=False,
            ),
            nullable=True,
        ),
        sa.Column(
            "filing_status",
            postgresql.ENUM(
                "single",
                "married_filing_jointly",
                "head_of_household",
                name="filing_status",
                create_type=False,
            ),
            nullable=True,
        ),
        sa.Column(
            "other_jobs",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("dependents", sa.SmallInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "expected_healthcare_usage",
            postgresql.ENUM("low", "medium", "high", name="healthcare_usage", create_type=False),
            nullable=True,
        ),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column(
            "match_tiers",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("vesting_years", sa.SmallInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "jsonb_typeof(match_tiers) = 'array'", name=op.f("ck_profiles_match_tiers_array")
        ),
        sa.CheckConstraint(
            "jsonb_typeof(other_jobs) = 'array'", name=op.f("ck_profiles_other_jobs_array")
        ),
        sa.CheckConstraint("dependents >= 0", name=op.f("ck_profiles_dependents_non_negative")),
        sa.CheckConstraint("salary_cents > 0", name=op.f("ck_profiles_salary_positive")),
        sa.CheckConstraint(
            "vesting_years >= 0", name=op.f("ck_profiles_vesting_years_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_profiles_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_profiles")),
    )
    op.create_table(
        "sync_items",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "provider",
            postgresql.ENUM("plaid", "csv", name="sync_provider", create_type=False),
            nullable=False,
        ),
        sa.Column("provider_item_id", sa.Text(), nullable=True),
        sa.Column("institution_name", sa.Text(), nullable=True),
        sa.Column("access_token_enc", sa.LargeBinary(), nullable=True),
        sa.Column("cursor", sa.Text(), nullable=True),
        sa.Column(
            "status",
            postgresql.ENUM(
                "active", "login_required", "error", name="sync_status", create_type=False
            ),
            server_default=sa.text("'active'"),
            nullable=False,
        ),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(provider = 'plaid') = (access_token_enc IS NOT NULL)",
            name=op.f("ck_sync_items_plaid_has_token"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_sync_items_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sync_items")),
        sa.UniqueConstraint("id", "user_id", name=op.f("uq_sync_items_id_user_id")),
    )
    op.create_index("ix_sync_items_user_id", "sync_items", ["user_id"], unique=False)
    op.create_index(
        "uq_sync_items_provider_item",
        "sync_items",
        ["provider", "provider_item_id"],
        unique=True,
        postgresql_where=sa.text("provider_item_id IS NOT NULL"),
    )
    op.create_table(
        "accounts",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("sync_item_id", sa.Uuid(), nullable=False),
        sa.Column("provider_account_id", sa.Text(), nullable=False),
        sa.Column(
            "kind",
            postgresql.ENUM(
                "checking",
                "savings",
                "credit",
                "investment",
                "retirement",
                name="account_kind",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("mask", sa.Text(), nullable=True),
        sa.Column(
            "role",
            postgresql.ENUM(
                "spending", "emergency_fund", "retirement", name="account_role", create_type=False
            ),
            nullable=True,
        ),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("mask ~ '^[0-9]{2,4}$'", name=op.f("ck_accounts_mask_digits")),
        sa.ForeignKeyConstraint(
            ["sync_item_id", "user_id"],
            ["sync_items.id", "sync_items.user_id"],
            name=op.f("fk_accounts_sync_item_id_sync_items"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_accounts_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_accounts")),
        sa.UniqueConstraint("id", "user_id", name=op.f("uq_accounts_id_user_id")),
        sa.UniqueConstraint(
            "sync_item_id",
            "provider_account_id",
            name=op.f("uq_accounts_sync_item_id_provider_account_id"),
        ),
    )
    op.create_index("ix_accounts_user_id", "accounts", ["user_id"], unique=False)
    op.create_index(
        "uq_accounts_one_emergency_fund",
        "accounts",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("role = 'emergency_fund'"),
    )
    op.create_table(
        "llm_calls",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "purpose",
            postgresql.ENUM(
                "extract", "categorize", "explain", name="llm_purpose", create_type=False
            ),
            nullable=False,
        ),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("output_tokens", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("cache_read_tokens", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("cost_microcents", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(
                "ok",
                "refusal",
                "schema_error",
                "api_error",
                "budget_blocked",
                name="llm_status",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "cache_read_tokens >= 0", name=op.f("ck_llm_calls_cache_read_tokens_non_negative")
        ),
        sa.CheckConstraint("cost_microcents >= 0", name=op.f("ck_llm_calls_cost_non_negative")),
        sa.CheckConstraint(
            "input_tokens >= 0", name=op.f("ck_llm_calls_input_tokens_non_negative")
        ),
        sa.CheckConstraint("latency_ms >= 0", name=op.f("ck_llm_calls_latency_non_negative")),
        sa.CheckConstraint(
            "output_tokens >= 0", name=op.f("ck_llm_calls_output_tokens_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["job_id"], ["jobs.id"], name=op.f("fk_llm_calls_job_id_jobs"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_llm_calls_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_llm_calls")),
    )
    op.create_index(
        "ix_llm_calls_user_created", "llm_calls", ["user_id", "created_at"], unique=False
    )
    op.create_table(
        "balance_snapshots",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("balance_cents", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["account_id", "user_id"],
            ["accounts.id", "accounts.user_id"],
            name=op.f("fk_balance_snapshots_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_balance_snapshots_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_balance_snapshots")),
        sa.UniqueConstraint(
            "account_id", "as_of", name=op.f("uq_balance_snapshots_account_id_as_of")
        ),
    )
    op.create_table(
        "holdings",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.Column("security_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("ticker", sa.Text(), nullable=True),
        sa.Column("quantity", sa.Numeric(precision=24, scale=8), nullable=False),
        sa.Column("value_cents", sa.BigInteger(), nullable=False),
        sa.Column("cost_basis_cents", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["account_id", "user_id"],
            ["accounts.id", "accounts.user_id"],
            name=op.f("fk_holdings_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_holdings_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_holdings")),
        sa.UniqueConstraint(
            "account_id",
            "as_of",
            "security_id",
            name=op.f("uq_holdings_account_id_as_of_security_id"),
        ),
    )
    op.create_table(
        "transactions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("provider_txn_id", sa.Text(), nullable=False),
        sa.Column("posted_at", sa.Date(), nullable=False),
        sa.Column("amount_cents", sa.BigInteger(), nullable=False),
        sa.Column("merchant_raw", sa.Text(), nullable=False),
        sa.Column("merchant_clean", sa.Text(), nullable=True),
        sa.Column("merchant_norm", sa.Text(), nullable=False),
        sa.Column("category", sa.Text(), nullable=True),
        sa.Column(
            "category_source",
            postgresql.ENUM("rule", "user", "llm", name="category_source", create_type=False),
            nullable=True,
        ),
        sa.Column("confidence", sa.Numeric(precision=4, scale=3), nullable=True),
        sa.Column("pending", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(category_source IS NOT DISTINCT FROM 'llm') = (confidence IS NOT NULL)",
            name=op.f("ck_transactions_confidence_only_for_llm"),
        ),
        sa.CheckConstraint(
            "(category IS NULL) = (category_source IS NULL)",
            name=op.f("ck_transactions_category_source_set_with_category"),
        ),
        sa.CheckConstraint(
            "confidence BETWEEN 0 AND 1", name=op.f("ck_transactions_confidence_range")
        ),
        sa.ForeignKeyConstraint(
            ["account_id", "user_id"],
            ["accounts.id", "accounts.user_id"],
            name=op.f("fk_transactions_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_transactions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_transactions")),
        sa.UniqueConstraint(
            "account_id", "provider_txn_id", name=op.f("uq_transactions_account_id_provider_txn_id")
        ),
    )
    op.create_index(
        "ix_transactions_user_category", "transactions", ["user_id", "category"], unique=False
    )
    op.create_index(
        "ix_transactions_user_merchant_norm",
        "transactions",
        ["user_id", "merchant_norm"],
        unique=False,
    )
    op.create_index(
        "ix_transactions_user_posted", "transactions", ["user_id", "posted_at", "id"], unique=False
    )

    for table in UPDATED_AT_TABLES:
        op.execute(
            f"CREATE TRIGGER {table}_set_updated_at BEFORE UPDATE ON public.{table}"
            " FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()"
        )
    _row_level_security()


def downgrade() -> None:
    for table in (
        "transactions",
        "holdings",
        "balance_snapshots",
        "llm_calls",
        "accounts",
        "sync_items",
        "profiles",
        "jobs",
        "category_rules",
    ):
        op.drop_table(table)
    op.execute("DROP FUNCTION public.set_updated_at()")
    for name in reversed(ENUMS):
        postgresql.ENUM(name=name).drop(op.get_bind())
