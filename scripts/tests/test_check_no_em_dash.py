"""The no-em-dash check used by pre-commit, `make lint` and CI."""

from __future__ import annotations

from pathlib import Path

import pytest

from scripts import check_no_em_dash

# Built with chr() so this file never contains the character it tests for.
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)


def test_reports_each_occurrence_with_its_position(tmp_path: Path) -> None:
    path = tmp_path / "notes.md"
    path.write_text(f"fine line\nbad {EM_DASH} here and {EM_DASH} there\n")
    assert check_no_em_dash.find_em_dashes(path) == [(2, 5), (2, 16)]


def test_clean_and_binary_files_pass(tmp_path: Path) -> None:
    clean = tmp_path / "clean.py"
    clean.write_text(f"x = 1  # a plain dash - is fine, and an en dash {EN_DASH} too\n")
    binary = tmp_path / "image.pdf"
    binary.write_bytes(b"%PDF\x00\x01" + EM_DASH.encode())
    assert check_no_em_dash.find_em_dashes(clean) == []
    assert check_no_em_dash.find_em_dashes(binary) == []


def test_main_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    clean = tmp_path / "a.txt"
    clean.write_text("ok\n")
    dirty = tmp_path / "b.txt"
    dirty.write_text(f"no {EM_DASH} thanks\n")
    assert check_no_em_dash.main([str(clean)]) == 0
    assert check_no_em_dash.main([str(clean), str(dirty)]) == 1
    assert f"{dirty}:1:4" in capsys.readouterr().out


def test_missing_files_are_skipped(tmp_path: Path) -> None:
    assert check_no_em_dash.main([str(tmp_path / "deleted.txt")]) == 0


def test_vendored_skill_files_are_skipped(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Third-party skills under .agents/skills are hash-locked; we do not edit their prose."""
    monkeypatch.setattr(check_no_em_dash, "REPO_ROOT", tmp_path)
    vendored = tmp_path / ".agents" / "skills" / "some-skill" / "SKILL.md"
    vendored.parent.mkdir(parents=True)
    vendored.write_text(f"their words {EM_DASH} their style\n")
    ours = tmp_path / "docs" / "notes.md"
    ours.parent.mkdir()
    ours.write_text(f"our words {EM_DASH} not allowed\n")
    assert check_no_em_dash.is_vendored(vendored)
    assert not check_no_em_dash.is_vendored(ours)
    assert check_no_em_dash.main([str(vendored)]) == 0
    assert check_no_em_dash.main([str(vendored), str(ours)]) == 1


def test_without_arguments_it_checks_tracked_files(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[Path]] = []

    def fake_check(paths: list[Path]) -> int:
        seen.append(paths)
        return 0

    monkeypatch.setattr(check_no_em_dash, "check", fake_check)
    assert check_no_em_dash.main([]) == 0
    assert check_no_em_dash.REPO_ROOT / "pyproject.toml" in seen[0]


def test_the_repository_is_clean() -> None:
    assert check_no_em_dash.main([]) == 0
