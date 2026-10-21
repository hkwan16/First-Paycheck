"""Settings: parsing, normalization, production guards and the .env.example contract."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.config import REPO_ROOT, Settings

ENV_EXAMPLE = REPO_ROOT / ".env.example"


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start each test from an empty environment (conftest pins test values)."""
    for aliases in _settings_env_names().values():
        for name in aliases:
            monkeypatch.delenv(name, raising=False)


def make(**values: Any) -> Settings:
    """Build settings from keyword values only, ignoring any .env file."""
    return Settings(_env_file=None, **values)


def test_blank_values_mean_unset() -> None:
    settings = make(database_url="", supabase_url="  ")
    assert settings.database_url is None
    assert settings.supabase_url is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("postgres://u:p@h:5432/db", "postgresql+psycopg://u:p@h:5432/db"),
        ("postgresql://u:p@h:6543/db", "postgresql+psycopg://u:p@h:6543/db"),
        ("postgresql+psycopg://u:p@h/db", "postgresql+psycopg://u:p@h/db"),
    ],
)
def test_database_urls_use_the_psycopg_driver(raw: str, expected: str) -> None:
    settings = make(database_url=raw, database_url_privileged=raw, test_database_url=raw)
    assert settings.database_url == expected
    assert settings.database_url_privileged == expected
    assert settings.test_database_url == expected


def test_unsupported_database_scheme_is_rejected() -> None:
    with pytest.raises(ValidationError, match="postgres"):
        make(database_url="mysql://u:p@h/db")


def test_jwks_url_and_issuer_derive_from_supabase_url() -> None:
    settings = make(supabase_url="https://abc.supabase.co/")
    assert settings.jwt_issuer == "https://abc.supabase.co/auth/v1"
    assert settings.jwks_url == "https://abc.supabase.co/auth/v1/.well-known/jwks.json"


def test_explicit_jwks_url_wins() -> None:
    settings = make(
        supabase_url="https://abc.supabase.co", supabase_jwks_url="https://keys.example/jwks"
    )
    assert settings.jwks_url == "https://keys.example/jwks"


def test_jwks_url_is_none_without_supabase_url() -> None:
    settings = make()
    assert settings.jwks_url is None
    assert settings.jwt_issuer is None


def test_cors_origins_parse_from_a_comma_separated_env_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CORS_ORIGINS", "https://a.example, https://b.example,,")
    assert Settings(_env_file=None).cors_origins == [
        "https://a.example",
        "https://b.example",
    ]


def test_invalid_cors_regex_is_rejected() -> None:
    with pytest.raises(ValidationError, match="CORS_ORIGIN_REGEX"):
        make(cors_origin_regex="([unclosed")


def test_git_sha_reads_render_git_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GIT_SHA", raising=False)
    monkeypatch.setenv("RENDER_GIT_COMMIT", "abc123")
    assert Settings(_env_file=None).git_sha == "abc123"


PRODUCTION = {
    "app_env": "production",
    "database_url": "postgresql://app_api:x@pooler:6543/postgres",
    "database_url_privileged": "postgresql://postgres:x@pooler:5432/postgres",
    "supabase_url": "https://abc.supabase.co",
    "cors_origins": ["https://first-paycheck.vercel.app"],
}


def test_production_settings_are_accepted_when_complete() -> None:
    assert make(**PRODUCTION).app_env == "production"


@pytest.mark.parametrize(
    "missing", ["database_url", "database_url_privileged", "supabase_url", "cors_origins"]
)
def test_production_requires_core_settings(missing: str) -> None:
    values = {k: v for k, v in PRODUCTION.items() if k != missing}
    with pytest.raises(ValidationError, match=missing.upper()):
        make(**values)


def test_production_forbids_an_inline_jwks() -> None:
    with pytest.raises(ValidationError, match="SUPABASE_JWKS"):
        make(**PRODUCTION, supabase_jwks='{"keys": []}')


def test_production_forbids_the_fake_llm() -> None:
    with pytest.raises(ValidationError, match="LLM_FAKE"):
        make(**PRODUCTION, llm_fake=True)


def test_dotenv_is_read_outside_tests(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("LOG_LEVEL=DEBUG\n")
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    monkeypatch.setenv("APP_ENV", "development")
    assert Settings(_env_file=env_file).log_level == "DEBUG"


def test_dotenv_is_ignored_when_app_env_is_test(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("LOG_LEVEL=DEBUG\n")
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    monkeypatch.setenv("APP_ENV", "test")
    assert Settings(_env_file=env_file).log_level == "INFO"


def _env_example_keys() -> set[str]:
    keys = set()
    for line in ENV_EXAMPLE.read_text().splitlines():
        match = re.match(r"^([A-Z][A-Z0-9_]*)=", line)
        if match:
            keys.add(match.group(1))
    return keys


def _settings_env_names() -> dict[str, set[str]]:
    names: dict[str, set[str]] = {}
    for field_name, field in Settings.model_fields.items():
        aliases = {field_name.upper()}
        alias = field.validation_alias
        if alias is not None:
            choices = getattr(alias, "choices", [alias])
            aliases = {str(choice).upper() for choice in choices}
        names[field_name] = aliases
    return names


def test_env_example_documents_every_setting() -> None:
    documented = _env_example_keys()
    missing = {
        field for field, aliases in _settings_env_names().items() if not aliases & documented
    }
    assert not missing, f"add these settings to .env.example: {sorted(missing)}"


def test_env_example_has_no_unknown_api_variables() -> None:
    known = set().union(*_settings_env_names().values())
    web_only = {key for key in _env_example_keys() if key.startswith("NEXT_PUBLIC_")}
    unknown = _env_example_keys() - known - web_only
    assert not unknown, f"no Settings field reads these .env.example keys: {sorted(unknown)}"
