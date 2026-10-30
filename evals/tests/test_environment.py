"""The eval tests run pinned to test settings, never the developer's .env."""

from __future__ import annotations

from app.config import Settings


def test_eval_tests_never_read_the_developer_env() -> None:
    # Run alone (pytest evals/tests) or after the API tests, Settings sees the
    # pinned test environment: no live key, the fake model, no .env values.
    settings = Settings()
    assert settings.app_env == "test"
    assert settings.anthropic_api_key is None
    assert settings.llm_fake is True
