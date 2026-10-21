"""No committed fixture holds a credential (recorded Plaid responses included).

``scripts/record_plaid_fixtures.py`` scrubs tokens and ids; this is the check
that it did, and that nothing else key-like was pasted into a fixture. The
configured live keys, when present, are compared without ever being printed.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.config import REPO_ROOT
from tests.support.env import live_credential

FIXTURE_DIRS = [REPO_ROOT / "api" / "tests" / "fixtures", REPO_ROOT / "evals" / "fixtures"]
TEXT_SUFFIXES = {".json", ".csv", ".txt", ".md"}
KEY_LIKE = {
    "plaid access token": re.compile(r"access-(?:sandbox|development|production)-[0-9a-f-]{8,}"),
    "plaid public token": re.compile(r"public-(?:sandbox|development|production)-[0-9a-f-]{8,}"),
    "plaid link token": re.compile(r"link-(?:sandbox|development|production)-[0-9a-f-]{8,}"),
    "anthropic key": re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}"),
    # Plaid client ids are 24 hex characters and secrets 30.
    "hex client id or secret": re.compile(
        r"(?<![0-9a-f])(?:[0-9a-f]{24}|[0-9a-f]{30})(?![0-9a-f])"
    ),
    "private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
}


def fixture_files() -> list[Path]:
    return sorted(
        path
        for directory in FIXTURE_DIRS
        for path in directory.rglob("*")
        if path.is_file() and path.suffix in TEXT_SUFFIXES
    )


def test_there_are_fixtures_to_check() -> None:
    names = {path.name for path in fixture_files()}
    assert {"accounts_get.json", "transactions_sync_page1.json"} <= names


@pytest.mark.parametrize("path", fixture_files(), ids=lambda path: path.name)
def test_no_key_like_strings(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    found = [name for name, pattern in KEY_LIKE.items() if pattern.search(text)]
    assert found == [], f"{path.relative_to(REPO_ROOT)} contains a {', '.join(found)}"


def test_configured_live_keys_never_appear_in_fixtures() -> None:
    secrets = [
        value
        for name in ("PLAID_CLIENT_ID", "PLAID_SECRET", "ANTHROPIC_API_KEY")
        if (value := live_credential(name)) and len(value) >= 8
    ]
    if not secrets:
        pytest.skip("no live credentials are configured")
    leaking = [
        path.relative_to(REPO_ROOT)
        for path in fixture_files()
        if any(secret in path.read_text(encoding="utf-8") for secret in secrets)
    ]
    # Only paths are reported, never the secret.
    assert leaking == []


def test_the_patterns_catch_what_they_should() -> None:
    samples = {
        "plaid access token": "access-sandbox-de3ce8ef-33f8-452c-a685-8671031fc0f6",
        "plaid public token": "public-sandbox-b0e2c4ee-a763-4df5-bfe9-46a46bce993d",
        "anthropic key": "sk-ant-api03-abcdefghijklmnop",
        "hex client id or secret": '"client_id": "5f2a9c1b8e4d3a7f6b0c1d2e"',
    }
    for name, sample in samples.items():
        assert KEY_LIKE[name].search(sample), name
    # Masked or ordinary identifiers do not trip them.
    assert not any(
        p.search('"account_id": "BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp"') for p in KEY_LIKE.values()
    )
