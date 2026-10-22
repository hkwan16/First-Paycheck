"""Whether WeasyPrint can be imported here, checked in a child process.

Importing WeasyPrint loads pango and cairo through cffi. On a laptop without
them it raises ``OSError``; with a half-matching Homebrew install, and other
native extensions already loaded, it can crash the interpreter outright, which
no ``except`` catches. Probing in a subprocess keeps a crash from taking the
whole test run down.
"""

from __future__ import annotations

import subprocess
import sys
from functools import cache


@cache
def weasyprint_loads() -> tuple[bool, str]:
    """``(True, "")`` when a fresh interpreter imports WeasyPrint, else the reason."""
    probe = subprocess.run(
        [sys.executable, "-c", "import weasyprint"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if probe.returncode == 0:
        return True, ""
    if probe.returncode < 0:
        return False, f"the import crashed the interpreter (signal {-probe.returncode})"
    last_line = (probe.stderr.strip().splitlines() or ["no output"])[-1]
    return False, last_line
