"""Architectural boundaries, enforced by walking the import graph of the source tree.

* ``calc/*`` imports only the standard library, ``pydantic`` and ``calc`` itself:
  money math has no I/O, no database and no LLM.
* ``anthropic`` is imported only by ``llm/gateway.py``.
* Routers never touch an engine: they get a ``UserSession`` from ``app.deps``.
* The privileged engine is used only by ``app/db.py`` (its definition),
  ``jobs/queue.py``, ``jobs/scheduler.py`` and the deploy-time seed loader
  ``db/seed/load.py`` (spec 001 rule 11).
* Pay stubs are read only through ``db/pay_stubs.py``, so a superseded copy is
  never counted (spec 005 rule 22d, issue 190).
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
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


BLOB_ALLOWED = {"ingest/store.py", "db/models.py"}
WORKER_ONLY_MODULES = {
    "ingest.reader",
    "ingest.ocr",
    "ingest.redact",
    "ingest.pipeline",
    "pdfplumber",
    "pypdfium2",
    "pytesseract",
    "PIL",
    # The plan PDF (spec 016 rule 13): WeasyPrint loads pango, so only the worker renders.
    "export.html",
    "export.pdf",
    "jinja2",
    "weasyprint",
}


def blob_violations(source: str) -> list[str]:
    found = [
        f"line {line}: uses {name}"
        for name, line in referenced_names(ast.parse(source))
        if name == "DocumentBlob"
    ]
    found += [
        f"line {node.lineno}: names document_blobs"
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and "document_blobs" in node.value
    ]
    return found


def worker_only_violations(source: str) -> list[str]:
    return [
        f"line {line}: imports {module}"
        for module, line in imported_modules(ast.parse(source))
        if module in WORKER_ONLY_MODULES or module.split(".")[0] in WORKER_ONLY_MODULES
    ]


@pytest.mark.parametrize(
    "source",
    [
        "from db.models import DocumentBlob",
        "session.execute(text('DELETE FROM document_blobs'))",
    ],
)
def test_blob_check_flags_direct_access(source: str) -> None:
    assert blob_violations(source)


@pytest.mark.parametrize(
    "source", ["from ingest.ocr import ocr_image", "import pytesseract", "from PIL import Image"]
)
def test_worker_only_check_flags_heavy_imports(source: str) -> None:
    assert worker_only_violations(source)


def test_only_the_store_touches_document_blobs() -> None:
    problems = {
        relative(path): found
        for path in python_files(API)
        if not path.is_relative_to(API / "tests")
        and not path.is_relative_to(API / "alembic")
        and relative(path) not in BLOB_ALLOWED
        and (found := blob_violations(path.read_text()))
    }
    assert not problems, f"only ingest/store.py may touch document_blobs: {problems}"


EXPORTS_ALLOWED = {"export/store.py", "db/models.py"}


def export_violations(source: str) -> list[str]:
    tree = ast.parse(source)
    found = [
        f"line {line}: uses {name}" for name, line in referenced_names(tree) if name == "PlanExport"
    ]
    found += [
        f"line {node.lineno}: names plan_exports"
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and "plan_exports" in node.value
    ]
    return found


def test_export_check_flags_direct_access() -> None:
    assert export_violations("from db.models import PlanExport")
    assert export_violations("session.execute(text('SELECT bytes FROM plan_exports'))")


def test_only_the_export_store_touches_plan_exports() -> None:
    """Spec 016 rule 14."""
    problems = {
        relative(path): found
        for path in python_files(API)
        if not path.is_relative_to(API / "tests")
        and not path.is_relative_to(API / "alembic")
        and relative(path) not in EXPORTS_ALLOWED
        and (found := export_violations(path.read_text()))
    }
    assert not problems, f"only export/store.py may touch plan_exports: {problems}"


PAY_STUB_READS_ALLOWED = {"db/pay_stubs.py", "db/models.py"}
QUERY_CALLS = {"select", "select_from", "get"}
SQL_NAMING_PAY_STUBS = re.compile(r"\b(from|join|update|into)\s+(public\.)?pay_stubs\b", re.I)


def pay_stub_query_violations(source: str) -> list[str]:
    """Queries of ``pay_stubs`` that do not start from ``current_pay_stubs()``:
    a ``select``, ``select_from`` or ``Session.get`` naming ``PayStub``, or SQL
    text naming the table (spec 005 rule 22d, issue 190)."""
    tree = ast.parse(source)
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if name in QUERY_CALLS and any(
            isinstance(inner, ast.Name) and inner.id == "PayStub"
            for arg in node.args
            for inner in ast.walk(arg)
        ):
            found.append(f"line {node.lineno}: {name}() of PayStub")
    found += [
        f"line {node.lineno}: names pay_stubs"
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and SQL_NAMING_PAY_STUBS.search(node.value)
    ]
    return found


@pytest.mark.parametrize(
    "source",
    [
        "session.scalars(select(PayStub).order_by(PayStub.pay_date))",
        "session.scalar(select(func.max(PayStub.pay_date)))",
        "select(func.count()).select_from(PayStub)",
        "session.get(PayStub, stub_id)",
        "session.execute(text('SELECT gross_cents FROM pay_stubs'))",
    ],
)
def test_pay_stub_check_flags_direct_queries(source: str) -> None:
    assert pay_stub_query_violations(source)


@pytest.mark.parametrize(
    "source",
    [
        "session.scalars(current_pay_stubs().order_by(*NEWEST_FIRST).limit(2))",
        "def of(stub: PayStub) -> PayStubOut: ...",
        "stub = PayStub(user_id=user_id, **fields)",
        "router = APIRouter(prefix='/pay-stubs')",
        '"""A confirmed pay stub (spec 001 ``pay_stubs``)."""',
    ],
)
def test_pay_stub_check_allows_current_reads(source: str) -> None:
    assert not pay_stub_query_violations(source)


def test_pay_stubs_are_read_only_through_current_pay_stubs() -> None:
    """Spec 005 rule 22d: a superseded copy is never counted, so no reader may
    query the table except through ``db/pay_stubs.py``."""
    problems = {
        relative(path): found
        for path in python_files(API)
        if not path.is_relative_to(API / "tests")
        and not path.is_relative_to(API / "alembic")
        and relative(path) not in PAY_STUB_READS_ALLOWED
        and (found := pay_stub_query_violations(path.read_text()))
    }
    assert not problems, f"read pay stubs through db.pay_stubs.current_pay_stubs: {problems}"


def test_routers_never_import_ocr_or_parsers() -> None:
    problems = {
        relative(path): found
        for path in python_files(API / "app")
        if (found := worker_only_violations(path.read_text()))
    }
    assert not problems, f"OCR and parsing run only in the worker: {problems}"


def test_the_api_process_does_not_load_ocr_or_parsers() -> None:
    probe = (
        "import sys, app.main; "
        "print(','.join(sorted(m for m in ('pytesseract', 'pdfplumber', 'pypdfium2', 'PIL',"
        " 'ingest.ocr', 'ingest.reader', 'ingest.pipeline', 'weasyprint', 'jinja2',"
        " 'export.html', 'export.pdf') if m in sys.modules)))"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=API,
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "APP_ENV": "test"},
    )
    assert result.stdout.strip() == ""


def test_the_walk_sees_the_source_tree() -> None:
    files = {relative(path) for path in python_files(API)}
    assert {"app/main.py", "app/db.py", "calc/__init__.py"} <= files
