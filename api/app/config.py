"""Application settings, read from the environment (and the repo's .env file locally).

Every variable here is documented in the repo's ``.env.example``; a unit test
keeps the two in sync. Settings that only matter to a later milestone are
optional, and the module that needs them fails with a clear message when
they are missing. ``APP_ENV=production`` turns on fail-fast checks: the core
database, auth and CORS settings and ``ANTHROPIC_API_KEY`` are required, and
test-only switches (``SUPABASE_JWKS``, ``LLM_FAKE``) are refused.
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator
from pydantic_settings import (
    BaseSettings,
    NoDecode,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

REPO_ROOT = Path(__file__).resolve().parents[2]

AppEnv = Literal["development", "test", "production"]

_DB_SCHEMES = ("postgresql+psycopg://", "postgresql://", "postgres://")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        validate_by_name=True,
        validate_by_alias=True,
    )

    # Runtime
    app_env: AppEnv = "development"
    log_level: str = "INFO"
    git_sha: str | None = Field(
        default=None, validation_alias=AliasChoices("GIT_SHA", "RENDER_GIT_COMMIT")
    )

    # Database. DATABASE_URL is the app_api role through the transaction pooler;
    # DATABASE_URL_PRIVILEGED is the postgres role through the session pooler
    # (Alembic, the job queue's dequeue, the scheduler).
    database_url: str | None = None
    database_url_privileged: str | None = None
    test_database_url: str | None = None

    # Supabase Auth
    supabase_url: str | None = None
    supabase_jwks_url: str | None = None
    supabase_jwks: str | None = None

    # CORS
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)
    cors_origin_regex: str | None = None

    # Plaid
    plaid_client_id: str | None = None
    plaid_secret: SecretStr | None = None
    plaid_env: Literal["sandbox", "production"] = "sandbox"
    plaid_webhook_url: str | None = None
    plaid_token_key: SecretStr | None = None

    # Anthropic (only llm/gateway.py reads these)
    anthropic_api_key: SecretStr | None = None
    llm_fake: bool = False
    llm_model_extract: str = "claude-sonnet-5-5"
    llm_model_categorize: str = "claude-haiku-5-5"
    llm_model_explain: str = "claude-sonnet-5-5"
    llm_daily_budget_cents: int = Field(default=50, ge=0)

    # Error reporting (app/sentry.py); unset means no Sentry at all.
    sentry_dsn: SecretStr | None = None

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # Tests must never pick up real credentials from a developer's .env.
        if os.environ.get("APP_ENV") == "test":
            return init_settings, env_settings, file_secret_settings
        return init_settings, env_settings, dotenv_settings, file_secret_settings

    @field_validator("*", mode="before")
    @classmethod
    def _blank_means_unset(cls, value: Any) -> Any:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("database_url", "database_url_privileged", "test_database_url")
    @classmethod
    def _psycopg_driver(cls, value: str | None) -> str | None:
        if value is None:
            return None
        for scheme in _DB_SCHEMES:
            if value.startswith(scheme):
                return "postgresql+psycopg://" + value.removeprefix(scheme)
        raise ValueError("must be a postgres:// or postgresql:// URL")

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("cors_origin_regex")
    @classmethod
    def _valid_regex(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                re.compile(value)
            except re.error as exc:
                raise ValueError(f"CORS_ORIGIN_REGEX is not a valid regex: {exc}") from exc
        return value

    @model_validator(mode="after")
    def _production_guards(self) -> Settings:
        if self.app_env != "production":
            return self
        problems = [
            f"{name.upper()} is required in production"
            for name in (
                "database_url",
                "database_url_privileged",
                "supabase_url",
                "cors_origins",
                # Without a model, categorization would quietly run rules only and
                # every document go to manual entry (spec 003 rule 12a, #133).
                "anthropic_api_key",
            )
            if not getattr(self, name)
        ]
        if self.supabase_jwks:
            problems.append("SUPABASE_JWKS (inline test keys) is not allowed in production")
        if self.llm_fake:
            problems.append("LLM_FAKE is not allowed in production")
        if problems:
            raise ValueError("; ".join(problems))
        return self

    @property
    def jwt_issuer(self) -> str | None:
        """The ``iss`` claim Supabase Auth puts in access tokens."""
        if self.supabase_url is None:
            return None
        return f"{self.supabase_url.rstrip('/')}/auth/v1"

    @property
    def jwks_url(self) -> str | None:
        """Where the project's public signing keys are published."""
        if self.supabase_jwks_url is not None:
            return self.supabase_jwks_url
        if self.jwt_issuer is None:
            return None
        return f"{self.jwt_issuer}/.well-known/jwks.json"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """The process-wide settings, read once."""
    return Settings()


def plaid_missing_settings(settings: Settings) -> list[str]:
    """The Plaid settings a deployment still lacks, by environment-variable name.

    Bank linking needs the client id and secret (the Plaid client) and the
    token key (the cipher for stored access tokens). ``GET /health`` reports
    the names, never the values, so a misconfigured deployment can be read
    from outside.
    """
    missing: list[str] = []
    if not settings.plaid_client_id:
        missing.append("PLAID_CLIENT_ID")
    if settings.plaid_secret is None or not settings.plaid_secret.get_secret_value():
        missing.append("PLAID_SECRET")
    if settings.plaid_token_key is None or not settings.plaid_token_key.get_secret_value():
        missing.append("PLAID_TOKEN_KEY")
    return missing
