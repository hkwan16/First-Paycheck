"""Agent context files stay in sync: .cursor/rules mirrors the root CLAUDE.md."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLAUDE_MD = REPO_ROOT / "CLAUDE.md"
CURSOR_RULE = REPO_ROOT / ".cursor" / "rules" / "first-paycheck.mdc"


def split_front_matter(text: str) -> tuple[str, str]:
    assert text.startswith("---\n"), "the Cursor rule must start with front matter"
    front, body = text[4:].split("\n---\n", 1)
    return front, body


def test_cursor_rule_always_applies() -> None:
    front, _ = split_front_matter(CURSOR_RULE.read_text())
    assert "alwaysApply: true" in front.splitlines()


def test_cursor_rule_body_is_the_root_claude_md() -> None:
    _, body = split_front_matter(CURSOR_RULE.read_text())
    assert body.lstrip("\n") == CLAUDE_MD.read_text(), (
        "update .cursor/rules/first-paycheck.mdc: its text after the front matter "
        "must equal CLAUDE.md"
    )


def test_package_context_files_exist() -> None:
    for path in ("api/CLAUDE.md", "evals/CLAUDE.md"):
        assert (REPO_ROOT / path).is_file(), f"{path} is missing"
