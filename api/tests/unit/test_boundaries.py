"""Architectural boundaries, enforced by walking the import graph of the source tree.

* ``calc/*`` imports only the standard library, ``pydantic`` and ``calc`` itself:
  money math has no I/O, no database and no LLM.
* ``anthropic`` is imported only by ``llm/gateway.py``.
* Routers never touch an engine: they get a ``UserSession`` from ``app.deps``.
* The privileged engine is used only by ``app/db.py`` (its definition),
  ``jobs/queue.py``, ``jobs/scheduler.py`` and the deploy-time seed loader
  ``db/seed/load.py`` (spec 001 rule 11).
"""

from __future__ import annotations

import ast
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.config import REPO_ROOT

API = REPO_ROOT / "api"
PYTHON_ROOTS = (API, REPO_ROOT / "evals", REPO_ROOT / "scripts")
EXCLUDED_DIRS = {"__pycache__", ".venv", "node_modules"}

CALC_ALLOWED = frozenset(sys.stdlib_module_names) | {"__future__", "pydantic", "calc"}
ANTHROPIC_ALLOWED = "api/llm/gateway.py"
PRIVILEGED_ALLOWED = {"app/db.py", "jobs/queue.py", "jobs/scheduler.py", "db/seed/load.py"}
ENGINE_NAMES = {"get_engine", "get_privileged_engine", "make_engine", "create_engine"}


def python_files(root: Path) -> Iterator[Path]:
    for path in sorted(root.rglob("*.py")):
        if not EXCLUDED_DIRS.intersection(path.parts):
            yield path


def imported_modules(tree: ast.AST) -> Iterator[tuple[str, int]]:
    """Absolute module names imported by ``tree`` (relative imports are skipped)."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name, node.lineno
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module, node.lineno


def referenced_names(tree: ast.AST) -> Iterator[tuple[str, int]]:
    """Every imported name, bare name and attribute name in ``tree``."""
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                yield alias.name, node.lineno
        elif isinstance(node, ast.Name):
            yield node.id, node.lineno
        elif isinstance(node, ast.Attribute):
            yield node.attr, node.lineno


def calc_violations(source: str) -> list[str]:
    return [
        f"line {line}: {module}"
        for module, line in imported_modules(ast.parse(source))
        if module.split(".")[0] not in CALC_ALLOWED
    ]


def anthropic_violations(source: str) -> list[str]:
    return [
        f"line {line}: {module}"
        for module, line in imported_modules(ast.parse(source))
        if module.split(".")[0] == "anthropic"
    ]


def router_violations(source: str) -> list[str]:
    tree = ast.parse(source)
    found = [
        f"line {line}: imports {module}"
        for module, line in imported_modules(tree)
        if module == "app.db" or module.startswith("app.db.")
    ]
    found += [
        f"line {line}: uses {name}" for name, line in referenced_names(tree) if name in ENGINE_NAMES
    ]
    return found


def privileged_violations(source: str) -> list[str]:
    return [
        f"line {line}: uses get_privileged_engine"
        for name, line in referenced_names(ast.parse(source))
        if name == "get_privileged_engine"
    ]


def relative(path: Path) -> str:
    return path.relative_to(API).as_posix()


# ---------------------------------------------------------------- the checks fire


@pytest.mark.parametrize(
    "source",
    [
        "import requests",
        "from sqlalchemy import select",
        "from app.db import get_engine",
        "import anthropic",
        "from llm.gateway import Gateway",
    ],
)
def test_calc_check_flags_outside_imports(source: str) -> None:
    assert calc_violations(source)


@pytest.mark.parametrize(
    "source",
    [
        "from __future__ import annotations",
        "from decimal import ROUND_HALF_UP, Decimal",
        "import datetime",
        "from pydantic import BaseModel, Field",
        "from calc.money import Cents",
        "from .money import Cents",
    ],
)
def test_calc_check_allows_pure_imports(source: str) -> None:
    assert not calc_violations(source)


@pytest.mark.parametrize(
    "source", ["import anthropic", "from anthropic import Anthropic", "import anthropic.types"]
)
def test_anthropic_check_flags_imports(source: str) -> None:
    assert anthropic_violations(source)


@pytest.mark.parametrize(
    "source",
    [
        "from app.db import get_engine",
        "import app.db",
        "from sqlalchemy import create_engine",
        "from app import db\nengine = db.get_privileged_engine()",
    ],
)
def test_router_check_flags_engine_access(source: str) -> None:
    assert router_violations(source)


def test_router_check_allows_the_user_session() -> None:
    assert not router_violations("from app.deps import UserSession\nfrom sqlalchemy import select")


def test_privileged_check_flags_use() -> None:
    assert privileged_violations("from app.db import get_privileged_engine")


# ---------------------------------------------------------------- the tree obeys them


def test_calc_imports_only_pure_modules() -> None:
    problems = {
        relative(path): found
        for path in python_files(API / "calc")
        if (found := calc_violations(path.read_text()))
    }
    assert not problems, f"calc/ must stay pure: {problems}"


def test_only_the_gateway_imports_anthropic() -> None:
    problems = {
        path.relative_to(REPO_ROOT).as_posix(): found
        for root in PYTHON_ROOTS
        for path in python_files(root)
        if path.relative_to(REPO_ROOT).as_posix() != ANTHROPIC_ALLOWED
        and (found := anthropic_violations(path.read_text()))
    }
    assert not problems, f"only api/llm/gateway.py may import anthropic: {problems}"


def test_routers_never_touch_an_engine() -> None:
    problems = {
        relative(path): found
        for path in python_files(API / "app" / "routers")
        if (found := router_violations(path.read_text()))
    }
    assert not problems, f"routers must use UserSession from app.deps: {problems}"


def test_privileged_engine_stays_in_its_allowed_modules() -> None:
    problems = {
        relative(path): found
        for path in python_files(API)
        if not path.is_relative_to(API / "tests")
        and not path.is_relative_to(API / "alembic")
        and relative(path) not in PRIVILEGED_ALLOWED
        and (found := privileged_violations(path.read_text()))
    }
    assert not problems, f"get_privileged_engine is for the queue, scheduler and seeds: {problems}"


def test_the_walk_sees_the_source_tree() -> None:
    files = {relative(path) for path in python_files(API)}
    assert {"app/main.py", "app/db.py", "calc/__init__.py"} <= files
