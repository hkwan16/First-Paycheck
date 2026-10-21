"""enqueue_sync_for_plaid_item: the Plaid webhook's only database access.

A verified webhook names a Plaid item but no user, and the API's ``app_api``
role cannot read ``sync_items`` (spec 001). This ``SECURITY DEFINER``
function, owned by the migrating role, looks the item up across users and
queues one ``sync.incremental`` job for its owner unless one is already
waiting. It returns nothing, so a caller learns nothing about which items
exist. ``search_path`` is pinned and only ``app_api`` may execute it.

The revision keeps spec 001's name, ``0006_webhook_fn``, although it is the
third revision applied: the next revision (``0003_documents``) revises it.

Revision ID: 0006_webhook_fn
Revises: 0002_core
Create Date: 2026-10-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006_webhook_fn"
down_revision: str | None = "0002_core"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CREATE_FUNCTION = """
CREATE FUNCTION public.enqueue_sync_for_plaid_item(p_provider_item_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_item_id uuid;
    v_user_id uuid;
    v_payload jsonb;
BEGIN
    SELECT id, user_id INTO v_item_id, v_user_id
    FROM public.sync_items
    WHERE provider = 'plaid' AND provider_item_id = p_provider_item_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    v_payload := jsonb_build_object('sync_item_id', v_item_id::text);
    -- Serialize concurrent webhooks for one item so the check below holds.
    -- Lock class 4201 is "one waiting sync per item" (the scheduler uses 42).
    PERFORM pg_advisory_xact_lock(4201, hashtext(v_item_id::text));
    IF EXISTS (
        SELECT 1 FROM public.jobs
        WHERE user_id = v_user_id
          AND kind = 'sync.incremental'
          AND status = 'queued'
          AND payload = v_payload
    ) THEN
        RETURN;
    END IF;

    INSERT INTO public.jobs (user_id, kind, payload)
    VALUES (v_user_id, 'sync.incremental', v_payload);
END;
$$
"""

SIGNATURE = "public.enqueue_sync_for_plaid_item(text)"


def upgrade() -> None:
    op.execute(CREATE_FUNCTION)
    op.execute(f"REVOKE ALL ON FUNCTION {SIGNATURE} FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION {SIGNATURE} TO app_api")


def downgrade() -> None:
    op.execute(f"DROP FUNCTION {SIGNATURE}")
