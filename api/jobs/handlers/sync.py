"""``sync.initial`` and ``sync.incremental``: one ``run_sync`` for the payload's item."""

from __future__ import annotations

import uuid
from typing import Any

from jobs.context import JobContext
from sync.pipeline import SyncItemSecrets, run_sync
from sync.provider import SyncProvider


def sync_item_id(payload: dict[str, Any]) -> uuid.UUID:
    try:
        return uuid.UUID(str(payload["sync_item_id"]))
    except (KeyError, ValueError):
        raise ValueError("sync_item_id is missing or not a UUID") from None


def run(ctx: JobContext) -> dict[str, Any]:
    item_id = sync_item_id(ctx.job.payload)
    configured = ctx.services.provider_for

    def provider_for(item: SyncItemSecrets) -> SyncProvider:
        # Built only once the item is found, so a sync queued for an unlinked
        # item succeeds as item_missing on any worker (spec 002 rule 17).
        if configured is None:
            raise RuntimeError("no sync provider is configured for this worker")
        return configured(item)

    result = run_sync(
        user_id=ctx.user_id,
        item_id=item_id,
        sessions=ctx.user_session,
        provider_for=provider_for,
    )
    return result.as_job_result()
