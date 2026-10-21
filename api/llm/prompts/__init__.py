"""Prompt files: ``llm/prompts/<name>/vN.md`` with YAML front matter (spec 003 rule 20).

Front matter fields, all required and no others:

- ``version``: ``<name>/vN``, matching the file's path; recorded in ``llm_calls``.
- ``model``: the settings purpose (``extract``, ``categorize``, ``explain``); the
  model id comes from ``LLM_MODEL_<PURPOSE>``, never from the file.
- ``effort``: ``low``, ``medium`` or ``high`` (``output_config.effort``).
- ``max_tokens``: a positive integer.
- ``schema``: a class name in ``llm/schemas.py``.

The body is the system prompt. A new prompt version is a new file; a released
file is never edited, so ``prompt_version`` always names the text that ran.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Literal, get_args

import yaml
from pydantic import BaseModel

from db.enums import LlmPurpose
from llm.schemas import SCHEMAS

PROMPTS_DIR = Path(__file__).resolve().parent

Effort = Literal["low", "medium", "high"]
_FIELDS = frozenset({"version", "model", "effort", "max_tokens", "schema"})
_FRONT_MATTER = re.compile(r"\A---\n(?P<meta>.*?)\n---\n(?P<body>.*)\Z", re.DOTALL)
_VERSION = re.compile(r"[a-z][a-z0-9_]*/v[1-9][0-9]*")

__all__ = ["PROMPTS_DIR", "Prompt", "PromptError", "all_prompts", "load_prompt", "parse_prompt"]


class PromptError(ValueError):
    """A prompt file is missing or malformed."""


@dataclass(frozen=True)
class Prompt:
    version: str
    purpose: LlmPurpose
    effort: Effort
    max_tokens: int
    schema: type[BaseModel]
    system: str


def parse_prompt(text: str, *, source: Path) -> Prompt:
    def fail(problem: str) -> PromptError:
        return PromptError(f"{source}: {problem}")

    match = _FRONT_MATTER.match(text)
    if match is None:
        raise fail("missing YAML front matter between --- lines")
    try:
        meta: Any = yaml.safe_load(match["meta"])
    except yaml.YAMLError as exc:
        raise fail(f"front matter is not valid YAML ({exc})") from None
    if not isinstance(meta, dict):
        raise fail("front matter must be a mapping")
    if missing := sorted(_FIELDS - meta.keys()):
        raise fail(f"missing front matter field(s): {', '.join(missing)}")
    if unknown := sorted(meta.keys() - _FIELDS):
        raise fail(f"unknown front matter field(s): {', '.join(map(str, unknown))}")

    version = meta["version"]
    if not isinstance(version, str) or not _VERSION.fullmatch(version):
        raise fail(f"version must look like 'name/v1', not {version!r}")
    try:
        purpose = LlmPurpose(meta["model"])
    except ValueError:
        choices = ", ".join(purpose.value for purpose in LlmPurpose)
        raise fail(f"model must be a settings purpose ({choices}), not {meta['model']!r}") from None
    effort = meta["effort"]
    if effort not in get_args(Effort):
        raise fail(f"effort must be low, medium or high, not {effort!r}")
    max_tokens = meta["max_tokens"]
    if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens < 1:
        raise fail(f"max_tokens must be a positive integer, not {max_tokens!r}")
    schema = SCHEMAS.get(str(meta["schema"]))
    if schema is None:
        raise fail(f"schema {meta['schema']!r} is not a class in llm/schemas.py")
    body = match["body"].strip()
    if not body:
        raise fail("the prompt body is empty")
    return Prompt(
        version=version,
        purpose=purpose,
        effort=effort,
        max_tokens=max_tokens,
        schema=schema,
        system=body,
    )


@cache
def load_prompt(name: str, version: str) -> Prompt:
    path = PROMPTS_DIR / name / f"{version}.md"
    if not path.is_file():
        raise PromptError(f"no prompt file for {name}/{version}")
    prompt = parse_prompt(path.read_text(encoding="utf-8"), source=path)
    if prompt.version != f"{name}/{version}":
        raise PromptError(f"{path}: version {prompt.version!r} does not match the file path")
    return prompt


def all_prompts() -> list[Prompt]:
    return [
        load_prompt(path.parent.name, path.stem) for path in sorted(PROMPTS_DIR.glob("*/v*.md"))
    ]
