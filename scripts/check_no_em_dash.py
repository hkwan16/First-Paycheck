"""Fail when a text file contains an em dash (U+2014). Use a plain dash instead.

    python scripts/check_no_em_dash.py [FILE ...]

With no arguments every git-tracked file is checked. Binary files (any NUL byte
in the first 8 KiB) and vendored third-party content under .agents/skills are
skipped. Used by pre-commit, `make lint` and CI.
"""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
# Built with chr() so this file never contains the character it searches for.
EM_DASH = chr(0x2014)
_EM_DASH_BYTES = EM_DASH.encode()
# Third-party content we vendor verbatim and must not rewrite (hash-locked by skills-lock.json).
VENDORED_DIRS = (Path(".agents") / "skills",)


def _is_binary(data: bytes) -> bool:
    return b"\x00" in data[:8192]


def is_vendored(path: Path) -> bool:
    """True for files under a vendored directory, resolved against the repo root."""
    try:
        relative = path.resolve().relative_to(REPO_ROOT.resolve())
    except ValueError:
        return False
    return any(relative.is_relative_to(vendored) for vendored in VENDORED_DIRS)


def find_em_dashes(path: Path) -> list[tuple[int, int]]:
    """1-based (line, column) of every em dash in ``path``; empty for binary files."""
    data = path.read_bytes()
    if _is_binary(data) or _EM_DASH_BYTES not in data:
        return []
    text = data.decode("utf-8", errors="replace")
    return [
        (number, column + 1)
        for number, line in enumerate(text.splitlines(), start=1)
        for column, char in enumerate(line)
        if char == EM_DASH
    ]


def check(paths: Sequence[Path]) -> int:
    found = 0
    for path in paths:
        if not path.is_file() or is_vendored(path):
            continue
        for line, column in find_em_dashes(path):
            print(f"{path}:{line}:{column}: em dash (U+2014); use a plain dash '-'")
            found += 1
    return 1 if found else 0


def tracked_files() -> list[Path]:
    output = subprocess.run(
        ["git", "ls-files", "-z"], cwd=REPO_ROOT, capture_output=True, check=True
    ).stdout
    return [REPO_ROOT / name for name in output.decode().split("\0") if name]


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    return check([Path(arg) for arg in args] if args else tracked_files())


if __name__ == "__main__":
    raise SystemExit(main())
