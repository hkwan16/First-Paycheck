"""Remove linked items at Plaid, best effort (spec 002 rule 28, spec 017 rule 3).

Unlinking an institution and deleting an account both ask Plaid to forget the
item before its row (and the encrypted token) is deleted. Nothing here may
stop the deletion: a Plaid error, a token that does not decrypt, or Plaid or
the token key not being configured is logged with the item id and skipped.
The caller holds no database transaction while this runs.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sync.crypto import TokenCipher, TokenDecryptError
from sync.plaid.client import PlaidError, PlaidLinking

__all__ = ["LinkedToken", "remove_at_provider"]

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LinkedToken:
    """A ``sync_items`` row's id and encrypted access token."""

    item_id: uuid.UUID
    access_token_enc: bytes


def remove_at_provider(
    plaid: PlaidLinking | None,
    cipher: TokenCipher | None,
    items: Iterable[LinkedToken],
) -> int:
    """Ask Plaid to remove each item; return how many it confirmed."""
    removed = 0
    for item in items:
        if plaid is None or cipher is None:
            logger.warning(
                "could not remove item %s at Plaid: Plaid is not configured",
                item.item_id,
                extra={"sync_item_id": str(item.item_id)},
            )
            continue
        try:
            plaid.item_remove(cipher.decrypt(item.access_token_enc))
        except (PlaidError, TokenDecryptError) as exc:
            logger.warning(
                "could not remove item %s at Plaid: %s",
                item.item_id,
                exc,  # neither error's message carries the token or a request body
                extra={"sync_item_id": str(item.item_id)},
            )
            continue
        removed += 1
    return removed
