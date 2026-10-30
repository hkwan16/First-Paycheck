"""Every Hypothesis test runs with the settings its own module asks for.

Hypothesis profiles are process-global, and ``@given`` captures the profile that
is active when the decorator runs. A test module that registers and loads a
profile at import time therefore changes the settings of every module imported
after it, so what a test gets depends on which files pytest collects and in what
order. The profiles are registered once, in ``tests/support/hypothesis_profiles.py``
(loaded by ``tests/conftest.py``), and a module that wants a different number of
examples says so on its tests with ``@settings(max_examples=...)``.
"""

from __future__ import annotations

import ast
import importlib
import inspect
import os
from collections.abc import Callable, Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

from hypothesis import settings

from app.config import REPO_ROOT

API = REPO_ROOT / "api"
TESTS = API / "tests"
PYTHON_ROOTS = (API, REPO_ROOT / "evals", REPO_ROOT / "scripts")
EXCLUDED_DIRS = {"__pycache__", ".venv", "node_modules"}
PROFILES_MODULE = "api/tests/support/hypothesis_profiles.py"
PROFILE_CALLS = {"register_profile", "load_profile"}

# The examples per test a module asks for; every other module runs the profile's.
ASKED_EXAMPLES = {
    "tests.unit.calc.test_emergency_fund_properties": 300,
    "tests.unit.calc.test_health_plans_properties": 150,
    "tests.unit.calc.test_k401_properties": 300,
    "tests.unit.calc.test_w4_properties": 150,
}


def python_files(root: Path) -> Iterator[Path]:
    for path in sorted(root.rglob("*.py")):
        if not EXCLUDED_DIRS.intersection(path.parts):
            yield path


def hypothesis_modules() -> Iterator[ModuleType]:
    """Every test module under ``api/tests`` that uses Hypothesis, imported."""
    for path in python_files(TESTS):
        if "hypothesis" not in path.read_text(encoding="utf-8"):
            continue
        name = ".".join(path.relative_to(API).with_suffix("").parts)
        yield importlib.import_module(name)


def property_tests(module: ModuleType) -> Iterator[Callable[..., Any]]:
    for _, member in inspect.getmembers(module, inspect.isfunction):
        if member.__module__ == module.__name__ and getattr(member, "is_hypothesis_test", False):
            yield member


def effective_settings(test: Callable[..., Any]) -> settings:
    """The settings Hypothesis runs ``test`` with.

    ``@given`` stores them on the wrapper when it decorates the test (the
    ``@settings`` ones, else the profile active at that moment) and reads them
    back on every call. Hypothesis has no public accessor for them, so this
    reads the attribute it uses itself; a rename fails here loudly.
    """
    found = vars(test)["_hypothesis_internal_use_settings"]
    assert isinstance(found, settings)
    return found


def active_profile() -> settings:
    profile = settings.default
    assert profile is not None
    return profile


def test_only_the_profiles_module_registers_or_loads_a_profile() -> None:
    offenders = []
    for root in PYTHON_ROOTS:
        for path in python_files(root):
            relative = path.relative_to(REPO_ROOT).as_posix()
            if relative == PROFILES_MODULE:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Attribute) and node.attr in PROFILE_CALLS:
                    offenders.append(f"{relative}:{node.lineno} {node.attr}")
    assert offenders == []


def test_the_profile_follows_ci() -> None:
    in_ci = bool(os.environ.get("CI"))
    assert settings.get_current_profile_name() == ("ci" if in_ci else "dev")
    assert active_profile().derandomize is in_ci
    assert active_profile().deadline is None


def test_every_property_test_runs_with_what_its_module_asks_for() -> None:
    profile = active_profile()
    found = {module.__name__: list(property_tests(module)) for module in hypothesis_modules()}
    found = {name: tests for name, tests in found.items() if tests}
    assert set(ASKED_EXAMPLES) <= set(found)
    wrong = []
    for name, tests in found.items():
        asked = ASKED_EXAMPLES.get(name, profile.max_examples)
        for test in tests:
            got = effective_settings(test)
            seen = (got.max_examples, got.derandomize, got.deadline)
            if seen != (asked, profile.derandomize, None):
                wrong.append(f"{name}.{test.__name__}: {seen}")
    assert wrong == []
