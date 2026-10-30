"""Pin the environment before any eval test reads settings, as api/tests does.

Without this, ``pytest evals/tests`` on its own builds ``Settings()`` from the
developer's .env, including a live ANTHROPIC_API_KEY when one is linked for a
live eval run. ``make test`` only escaped that because api/tests/conftest.py is
collected first.
"""

from __future__ import annotations

from tests.support.env import pin_test_environment

pin_test_environment()
