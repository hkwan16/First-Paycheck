"""Stored inputs are read without today's entry limits (spec 007 rule 2b, issue 238).

A decision is immutable and an entry limit can tighten after it was saved, so
every read of a calculator's input model outside the two places a person
enters inputs (``POST /calc/*``, whose bodies FastAPI validates, and
``POST /decisions``) passes ``context=STORED``. Without it, a version saved
under an older limit would make the screen that shows it answer 500.
"""

from __future__ import annotations

import ast
from pathlib import Path

from app.config import REPO_ROOT
from calc.registry import CALCULATORS

API = REPO_ROOT / "api"
INPUT_MODELS = {spec.input_model.__name__ for spec in CALCULATORS.values()}
# Where a person enters inputs: the entry limits hold there (spec 007 rule 2a).
ENTRY = {"app/routers/decisions.py"}


def reads_of_input_models(tree: ast.AST) -> list[tuple[int, bool]]:
    """Each ``<input model>.model_validate(...)`` call: its line, and whether it
    passes a context."""
    reads = []
    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "model_validate"
        ):
            continue
        owner = node.func.value
        named = isinstance(owner, ast.Name) and owner.id in INPUT_MODELS
        registered = isinstance(owner, ast.Attribute) and owner.attr == "input_model"
        if named or registered:
            reads.append((node.lineno, any(kw.arg == "context" for kw in node.keywords)))
    return reads


def source_files() -> list[Path]:
    return [
        path
        for path in sorted(API.rglob("*.py"))
        if not {"tests", ".venv", "__pycache__", "alembic"}.intersection(path.parts)
    ]


def test_every_read_of_stored_inputs_passes_the_stored_context() -> None:
    offenders = []
    for path in source_files():
        relative = path.relative_to(API).as_posix()
        if relative in ENTRY:
            continue
        for line, has_context in reads_of_input_models(ast.parse(path.read_text())):
            if not has_context:
                offenders.append(f"{relative}:{line}")
    assert offenders == [], (
        "read stored decision inputs with context=STORED (spec 007 rule 2b): "
        + ", ".join(offenders)
    )


def test_the_walk_finds_the_reads_it_is_about() -> None:
    """The check would pass vacuously if it matched nothing."""
    found = {
        path.relative_to(API).as_posix()
        for path in source_files()
        if reads_of_input_models(ast.parse(path.read_text()))
    }
    assert {"app/plan.py", "app/decision_review.py", "retrieval/context.py"} <= found
