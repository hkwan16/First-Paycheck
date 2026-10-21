"""Record Plaid sandbox responses as test fixtures (stub; implemented in M1).

The plan: create a sandbox public token for a test institution with
``/sandbox/public_token/create``, exchange it, page through
``/transactions/sync`` (retrying ``PRODUCT_NOT_READY``), then call
``/accounts/balance/get`` and, when requested, ``/investments/holdings/get``.
Each response is written as JSON under ``--out`` with access tokens, item ids
and request ids scrubbed, so unit tests can replay a realistic sync without
network access.

    uv run python scripts/record_plaid_fixtures.py --products transactions investments

Requires PLAID_CLIENT_ID and PLAID_SECRET for the sandbox environment.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "api" / "tests" / "fixtures" / "plaid"


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


def main(argv: Sequence[str] | None = None) -> int:
    parse_args(argv)
    sys.stderr.write("record_plaid_fixtures is not implemented yet (milestone M1)\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
