"""Record Plaid sandbox responses as test fixtures.

Creates a sandbox item for a test institution with
``/sandbox/public_token/create``, exchanges it, pages through
``/transactions/sync`` (waiting while Plaid prepares the data), then records
``/accounts/get`` and, when requested, ``/investments/holdings/get``. Each
response is written as JSON under ``--out`` with access tokens, item ids and
request ids scrubbed, so unit tests can replay a realistic sync offline. The
sandbox item is removed at the end.

    uv run python scripts/record_plaid_fixtures.py --products transactions investments

Requires PLAID_CLIENT_ID and PLAID_SECRET for the sandbox environment
(PLAID_ENV=sandbox); production credentials are refused.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable, Sequence
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

from pydantic import SecretStr

from app.config import Settings
from sync.plaid.client import PlaidClient, PlaidError, PlaidNotConfigured

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "api" / "tests" / "fixtures" / "plaid"
# Plaid usually has sandbox transactions ready within a few seconds.
READY_ATTEMPTS = 12
READY_WAIT_SECONDS = 5.0
REDACTED = {"item_id": "item-redacted", "request_id": "request-redacted"}


class RecorderClient(Protocol):
    def sandbox_public_token_create(
        self, institution_id: str, *, webhook: str | None = None, username: str | None = None
    ) -> str: ...

    def item_public_token_exchange(self, public_token: str) -> tuple[SecretStr, str]: ...

    def transactions_sync(self, access_token: SecretStr, cursor: str | None) -> dict[str, Any]: ...

    def accounts_get(self, access_token: SecretStr) -> dict[str, Any]: ...

    def investments_holdings_get(self, access_token: SecretStr) -> dict[str, Any]: ...

    def item_remove(self, access_token: SecretStr) -> None: ...


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0] if __doc__ else None)
    parser.add_argument(
        "--institution",
        default="ins_109508",
        help="sandbox institution id (default: First Platypus Bank)",
    )
    parser.add_argument(
        "--username",
        default="user_good",
        help="sandbox user, e.g. user_good or a custom sandbox user",
    )
    parser.add_argument(
        "--products",
        nargs="+",
        default=["transactions"],
        choices=["transactions", "investments"],
        help="Plaid products to record",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="fixture directory")
    return parser.parse_args(argv)


def scrub(value: Any, secrets: set[str]) -> Any:
    """Replace secrets, item ids and request ids anywhere in a response."""
    if isinstance(value, dict):
        return {
            key: REDACTED[key] if key in REDACTED and value[key] else scrub(item, secrets)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [scrub(item, secrets) for item in value]
    if isinstance(value, str) and value in secrets:
        return "redacted"
    return value


def _write(out: Path, name: str, body: dict[str, Any], secrets: set[str]) -> Path:
    path = out / f"{name}.json"
    # Decimal back to a JSON number: float's shortest repr reproduces Plaid's text.
    text = json.dumps(scrub(body, secrets), indent=2, default=_number)
    path.write_text(text + "\n", encoding="utf-8")
    return path


def _number(value: object) -> float:
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"cannot write {type(value).__name__} as JSON")


def _first_page(
    client: RecorderClient, token: SecretStr, sleep: Callable[[float], None]
) -> dict[str, Any]:
    for _ in range(READY_ATTEMPTS):
        try:
            body = client.transactions_sync(token, None)
        except PlaidError as exc:
            if exc.code != "PRODUCT_NOT_READY":
                raise
        else:
            if body.get("transactions_update_status") != "NOT_READY":
                return body
        sleep(READY_WAIT_SECONDS)
    raise TimeoutError("Plaid did not finish preparing sandbox transactions")


def record(
    client: RecorderClient,
    *,
    institution: str,
    username: str,
    products: Sequence[str],
    out: Path,
    sleep: Callable[[float], None] = time.sleep,
) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    public_token = client.sandbox_public_token_create(institution, username=username)
    token, item_id = client.item_public_token_exchange(public_token)
    secrets = {token.get_secret_value(), item_id, public_token}
    written: list[Path] = []
    try:
        if "transactions" in products:
            body = _first_page(client, token, sleep)
            number = 1
            written.append(_write(out, f"transactions_sync_page{number}", body, secrets))
            while body["has_more"]:
                body = client.transactions_sync(token, body["next_cursor"])
                number += 1
                written.append(_write(out, f"transactions_sync_page{number}", body, secrets))
        written.append(_write(out, "accounts_get", client.accounts_get(token), secrets))
        if "investments" in products:
            holdings = client.investments_holdings_get(token)
            written.append(_write(out, "investments_holdings_get", holdings, secrets))
    finally:
        client.item_remove(token)
    return written


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    settings = Settings()
    try:
        client = PlaidClient.from_settings(settings)
    except PlaidNotConfigured as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    if settings.plaid_env != "sandbox":
        sys.stderr.write("refusing to record fixtures outside the Plaid sandbox (PLAID_ENV)\n")
        return 2
    written = record(
        client,
        institution=args.institution,
        username=args.username,
        products=args.products,
        out=args.out,
    )
    for path in written:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
