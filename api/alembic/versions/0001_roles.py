"""Roles: the app_api login role and public.current_user_id().

``app_api`` is the role the API and worker connect as. It is NOINHERIT and owns
nothing: it reaches data only by ``SET LOCAL ROLE authenticated`` inside a
transaction that also sets ``request.jwt.claims``, so row-level security
applies to every query (see app/db.py).

The role is cluster-wide and may already exist with a password set from the
Supabase SQL editor, so it is created only when missing and is never dropped;
its membership of ``authenticated`` is granted once and kept on downgrade for
the same reason. Only the per-database grants are reverted.

Revision ID: 0001_roles
Revises:
Create Date: 2026-10-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001_roles"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Roles are cluster-wide and every database's test run migrates the same
    # one, so write the catalog only when something is missing: a second
    # ALTER or GRANT at the same moment fails with "tuple concurrently updated".
    op.execute(
        """
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_api') THEN
            CREATE ROLE app_api NOLOGIN NOINHERIT;
          END IF;
          IF (SELECT rolinherit FROM pg_roles WHERE rolname = 'app_api') THEN
            ALTER ROLE app_api NOINHERIT;
          END IF;
          IF NOT pg_has_role('app_api', 'authenticated', 'MEMBER') THEN
            GRANT authenticated TO app_api;
          END IF;
        END
        $$
        """
    )
    op.execute("GRANT USAGE ON SCHEMA public TO app_api")
    # GET /health reports the migration revision over the app_api connection.
    op.execute("GRANT SELECT ON public.alembic_version TO app_api")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION public.current_user_id() RETURNS uuid
        LANGUAGE sql STABLE
        AS $$ SELECT auth.uid() $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION public.current_user_id() FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION public.current_user_id() TO authenticated")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS public.current_user_id()")
    op.execute("REVOKE SELECT ON public.alembic_version FROM app_api")
    op.execute("REVOKE USAGE ON SCHEMA public FROM app_api")
    # The role and its membership of authenticated are cluster-wide, like the
    # role itself they stay: other databases on the cluster still use them.
