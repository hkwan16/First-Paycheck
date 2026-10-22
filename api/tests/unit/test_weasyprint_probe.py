"""The WeasyPrint probe reports a clean failure, a crash, or success."""

from __future__ import annotations

import subprocess
from typing import Any

import pytest

from tests.support import weasyprint_probe


def fake_run(returncode: int, stderr: str = "") -> Any:
    def run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        assert argv[1:] == ["-c", "import weasyprint"]
        return subprocess.CompletedProcess(argv, returncode, stdout="", stderr=stderr)

    return run


@pytest.mark.parametrize(
    ("returncode", "stderr", "expected"),
    [
        (0, "", (True, "")),
        (
            1,
            "Traceback\nOSError: cannot load library 'libgobject-2.0-0'",
            (False, "OSError: cannot load library 'libgobject-2.0-0'"),
        ),
        (-11, "", (False, "the import crashed the interpreter (signal 11)")),
    ],
    ids=["loads", "oserror", "segfault"],
)
def test_probe_outcomes(
    monkeypatch: pytest.MonkeyPatch, returncode: int, stderr: str, expected: tuple[bool, str]
) -> None:
    weasyprint_probe.weasyprint_loads.cache_clear()
    monkeypatch.setattr(subprocess, "run", fake_run(returncode, stderr))
    assert weasyprint_probe.weasyprint_loads() == expected
    weasyprint_probe.weasyprint_loads.cache_clear()
