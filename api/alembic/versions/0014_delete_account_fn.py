"""delete_user_account: account deletion's one cross-user write (spec 017).

``DELETE /me`` must delete the user's ``auth.users`` row, which neither
``authenticated`` nor ``app_api`` can touch. This ``SECURITY DEFINER``
function, owned by the migrating role, deletes exactly the row it is given;
every user-owned table references ``auth.users(id) ON DELETE CASCADE`` (spec
001 rule 5), so the one delete removes every row the user owns, decisions
included (``decisions_immutable`` allows the cascade, spec 007 rule 9). It
returns whether a row was deleted. ``search_path`` is pinned and only
``app_api`` may execute it; the route passes the verified token's ``sub``.

Revision ID: 0014_delete_account_fn
Revises: 0013_plan_export_job
Create Date: 2026-10-21
"""

from collections.abc import Sequence

from alembic import op

from db.rls import restrict_function

revision: str = "0014_delete_account_fn"
down_revision: str | None = "0013_plan_export_job"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CREATE_FUNCTION = """
CREATE FUNCTION public.delete_user_account(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'user id is required' USING ERRCODE = 'null_value_not_allowed';
    END IF;
    DELETE FROM auth.users WHERE id = p_user_id;
    RETURN FOUND;
END;
$$
"""


def upgrade() -> None:
    op.execute(CREATE_FUNCTION)
    restrict_function("delete_user_account(uuid)", execute=["app_api"])


def downgrade() -> None:
    op.execute("DROP FUNCTION public.delete_user_account(uuid)")
