"""Deleting the signed-in user's account (spec 017)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Response, status
from sqlalchemy import select, text

from app.auth import CurrentUser
from app.deps import OptionalCipher, OptionalPlaid, ServiceSessions, UserSessions
from app.errors import error_responses
from db.models import SyncItem
from sync.revoke import LinkedToken, remove_at_provider

logger = logging.getLogger(__name__)

router = APIRouter(tags=["account"])


@router.delete(
    "/me",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    responses=error_responses(401),
)
def delete_account(
    user: CurrentUser,
    sessions: UserSessions,
    service_sessions: ServiceSessions,
    plaid: OptionalPlaid,
    cipher: OptionalCipher,
) -> None:
    """Delete the signed-in user's account and every row they own, after
    removing their linked institutions at Plaid (best effort)."""
    # Rule 2: read the tokens, revoke with no transaction open, then delete.
    with sessions() as session:
        linked = [
            LinkedToken(item_id=item_id, access_token_enc=token)
            for item_id, token in session.execute(
                select(SyncItem.id, SyncItem.access_token_enc)
                .where(SyncItem.access_token_enc.is_not(None))
                .order_by(SyncItem.created_at, SyncItem.id)
            )
            if token is not None
        ]
    removed = remove_at_provider(plaid, cipher, linked)
    with service_sessions() as session:
        deleted = session.execute(
            text("SELECT public.delete_user_account(:user_id)"), {"user_id": user.id}
        ).scalar_one()
    logger.info(
        "account deleted",
        extra={
            "user_id": str(user.id),
            "deleted": bool(deleted),
            "items": len(linked),
            "removed_at_plaid": removed,
        },
    )
