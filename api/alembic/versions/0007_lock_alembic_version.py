"""Take alembic_version and the public functions away from the Supabase API roles.

Supabase's default privileges hand every new table and function in ``public``
to ``anon`` and ``authenticated``, the roles behind the Data API and the
publishable key. ``db.rls.enable_rls`` revokes those grants per table, but two
kinds of object never went through it:

* ``alembic_version``, which Alembic creates before the first migration runs,
  so the migration pointer was readable and writable with the publishable key;
* the functions. ``REVOKE ... FROM PUBLIC`` in 0001 and 0006 does not touch an
  explicit grant to ``anon``, so ``enqueue_sync_for_plaid_item`` (SECURITY
  DEFINER, meant for ``app_api`` alone) was callable as an RPC by anyone.

Each object is revoked from PUBLIC, ``anon`` and ``authenticated`` and then
granted back exactly what its migration intended. The test suite's auth shim
copies the same default privileges, so a future object that skips its revoke
fails ``test_migrations`` instead of leaking on the hosted project.

Revision ID: 0007_lock_alembic_version
Revises: 0003_documents
Create Date: 2026-10-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007_lock_alembic_version"
down_revision: str | None = "0003_documents"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

API_ROLES = "PUBLIC, anon, authenticated"


def upgrade() -> None:
    op.execute(f"REVOKE ALL ON public.alembic_version FROM {API_ROLES}")
    # GET /health reads the revision over the app_api connection (0001).
    op.execute("GRANT SELECT ON public.alembic_version TO app_api")

    # Policies call current_user_id() as the authenticated role (0001).
    op.execute(f"REVOKE ALL ON FUNCTION public.current_user_id() FROM {API_ROLES}")
    op.execute("GRANT EXECUTE ON FUNCTION public.current_user_id() TO authenticated")

    # Only the webhook, on the app_api connection, may enqueue by item id (0006).
    op.execute(f"REVOKE ALL ON FUNCTION public.enqueue_sync_for_plaid_item(text) FROM {API_ROLES}")
    op.execute("GRANT EXECUTE ON FUNCTION public.enqueue_sync_for_plaid_item(text) TO app_api")

    # updated_at triggers fire for the authenticated role's own writes (0002);
    # the function cannot be called outside a trigger, so the grant is harmless.
    op.execute(f"REVOKE ALL ON FUNCTION public.set_updated_at() FROM {API_ROLES}")
    op.execute("GRANT EXECUTE ON FUNCTION public.set_updated_at() TO authenticated")


def downgrade() -> None:
    # The extra grants came from Supabase's defaults, not from a migration, so
    # there is nothing to put back: the intended grants above are what 0001,
    # 0002 and 0006 leave on a database without those defaults.
    pass
