"""Which commit is running."""

from __future__ import annotations

import subprocess
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def resolve_git_sha(configured: str | None) -> str:
    """The configured SHA (GIT_SHA or Render's RENDER_GIT_COMMIT), else ``git rev-parse``.

    The Docker image has no git, so a deployed container relies on the setting.
    """
    if configured:
        return configured
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],  # noqa: S607 (git from PATH is intended)
            capture_output=True,
            text=True,
            check=True,
            cwd=_HERE,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return result.stdout.strip() or "unknown"
