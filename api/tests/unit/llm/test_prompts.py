"""Prompt files: YAML front matter, a known schema and a body (spec 003 rule 20)."""

from __future__ import annotations

from pathlib import Path

import pytest

from db.enums import LlmPurpose
from llm import schemas
from llm.prompts import PROMPTS_DIR, Prompt, PromptError, all_prompts, load_prompt, parse_prompt

VALID = """---
version: demo/v1
model: categorize
effort: low
max_tokens: 1000
schema: CategoryBatch
---
You label merchants.
"""


def test_every_prompt_file_loads() -> None:
    files = sorted(PROMPTS_DIR.glob("*/v*.md"))
    assert files, "no prompt files found"
    prompts = all_prompts()
    assert len(prompts) == len(files)
    for prompt in prompts:
        assert prompt.schema is getattr(schemas, prompt.schema.__name__)
        assert prompt.system.strip()


def test_version_matches_the_file_path() -> None:
    for path in PROMPTS_DIR.glob("*/v*.md"):
        prompt = parse_prompt(path.read_text(), source=path)
        assert prompt.version == f"{path.parent.name}/{path.stem}"


def test_categorize_v1() -> None:
    prompt = load_prompt("categorize", "v1")
    assert prompt.version == "categorize/v1"
    assert prompt.purpose is LlmPurpose.CATEGORIZE
    assert prompt.effort == "low"
    assert prompt.schema is schemas.CategoryBatch
    # The prompt names every category the schema accepts.
    for category in schemas.CATEGORIES:
        assert f"`{category}`" in prompt.system


def test_parse_valid_prompt() -> None:
    prompt = parse_prompt(VALID, source=Path("demo/v1.md"))
    assert prompt == Prompt(
        version="demo/v1",
        purpose=LlmPurpose.CATEGORIZE,
        effort="low",
        max_tokens=1000,
        schema=schemas.CategoryBatch,
        system="You label merchants.",
    )


@pytest.mark.parametrize(
    ("text", "problem"),
    [
        ("You label merchants.\n", "front matter"),
        (VALID.replace("schema: CategoryBatch\n", ""), "schema"),
        (VALID.replace("CategoryBatch", "NoSuchSchema"), "NoSuchSchema"),
        (VALID.replace("model: categorize", "model: claude-haiku-5-5"), "model"),
        (VALID.replace("effort: low", "effort: extreme"), "effort"),
        (VALID.replace("max_tokens: 1000", "max_tokens: 0"), "max_tokens"),
        (VALID.replace("max_tokens: 1000", "max_tokens: lots"), "max_tokens"),
        (VALID.replace("version: demo/v1", "version: v1"), "version"),
        (VALID.replace("You label merchants.\n", "   \n"), "body"),
        (VALID.replace("effort: low\n", "effort: low\ntemperature: 0\n"), "temperature"),
        ("---\n[not, a, mapping]\n---\nbody\n", "mapping"),
    ],
)
def test_invalid_prompts_are_rejected(text: str, problem: str) -> None:
    with pytest.raises(PromptError, match=problem):
        parse_prompt(text, source=Path("demo/v1.md"))


def test_missing_prompt_is_an_error() -> None:
    with pytest.raises(PromptError, match="categorize/v99"):
        load_prompt("categorize", "v99")
