"""Error messages are sentences for people (spec 008 rule 22a, issue 162).

The web shows an API error's ``message`` as it is (``apiErrorMessage``), so
an identifier in one reaches the screen: issue 162's "emergency_fund
decisions cannot be explained yet". This walks every ``AppError`` (and
subclass) call in the API and refuses a message whose words include a
``snake_case`` or ``SCREAMING_CASE`` identifier, or whose f-string
interpolates an enum's ``.value``, an identifier-valued attribute or a
``!r``. A message passed in a variable is checked where it is written.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[2]
SOURCES = (
    "app",
    "calc",
    "checkin",
    "db",
    "export",
    "ingest",
    "jobs",
    "llm",
    "retrieval",
    "sync",
    "verify",
)
ERRORS = {"AppError", "NotFound", "Unauthorized", "RateLimited"}
# A word with an underscore inside: a field, a code, an enum value.
IDENTIFIER = re.compile(r"\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b")
# Attributes that hold identifiers rather than words (enum values and codes).
IDENTIFIER_ATTRIBUTES = {"value", "calculator", "type", "kind", "code", "status"}


def _message(call: ast.Call) -> ast.expr | None:
    if call.args:
        return call.args[0]
    for keyword in call.keywords:
        if keyword.arg == "message":
            return keyword.value
    return None


def problems_in(source: str) -> list[str]:
    found = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
        if name not in ERRORS:
            continue
        message = _message(node)
        parts: list[ast.expr]
        if isinstance(message, ast.Constant):
            parts = [message]
        elif isinstance(message, ast.JoinedStr):
            parts = list(message.values)
        else:
            continue
        for part in parts:
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                for word in IDENTIFIER.findall(part.value):
                    found.append(f"line {node.lineno}: identifier {word!r}")
            elif isinstance(part, ast.FormattedValue):
                if part.conversion == ord("r"):
                    found.append(f"line {node.lineno}: !r interpolation")
                value = part.value
                if isinstance(value, ast.Attribute) and value.attr in IDENTIFIER_ATTRIBUTES:
                    found.append(f"line {node.lineno}: interpolates .{value.attr}")
    return found


@pytest.mark.parametrize(
    "source",
    [
        'AppError("emergency_fund decisions cannot be explained yet")',
        'AppError(f"{decision.calculator} decisions cannot be explained yet")',
        'NotFound(f"A {kind.value} was not found")',
        'AppError(f"Send it under {key!r}")',
        'AppError(message="Plaid rejected the request (INVALID_PUBLIC_TOKEN)")',
        'AppError("birth_year: must be at most 2026", code="validation_error")',
    ],
)
def test_the_check_flags_identifiers(source: str) -> None:
    assert problems_in(source)


@pytest.mark.parametrize(
    "source",
    [
        'AppError("Pick a plan before saving", code="plan_not_selected")',
        'AppError(f"The period can be at most {MAX_SPAN_DAYS} days")',
        'AppError(f"Gross minus deductions is {dollars(expected)}")',
        "AppError(message)",
        'NotFound("Decision not found")',
    ],
)
def test_the_check_passes_sentences(source: str) -> None:
    assert problems_in(source) == []


def test_every_api_error_message_is_for_people() -> None:
    problems = {
        path.relative_to(API).as_posix(): found
        for folder in SOURCES
        for path in sorted((API / folder).rglob("*.py"))
        if (found := problems_in(path.read_text(encoding="utf-8")))
    }
    assert problems == {}
