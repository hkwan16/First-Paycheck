"""The Hypothesis profiles every test runs under, registered and loaded once.

``tests/conftest.py`` calls :func:`load` before any test module is imported.
Profiles are process-global and ``@given`` captures the active one when it
decorates a test, so no test module registers or loads a profile of its own
(``tests/unit/test_hypothesis_settings.py`` checks). A module that wants more
examples than the profile's 100 asks on each test with
``@settings(max_examples=...)``, which overrides that one setting only.

Two profiles, picked by the ``CI`` variable the CI jobs set:

* ``ci`` is Hypothesis's own CI profile: ``derandomize=True`` (the same examples
  every run, so a CI failure reproduces locally with ``CI=1``), no example
  database, failing blobs printed.
* ``dev`` is the default profile with random examples and the local database.

Both have no deadline. Hypothesis's default deadline (200 ms per example) fails
an example whose wall-clock time is over it, and every property test here
calls pure, CPU-bound code with bounded inputs: its time depends on how busy
the machine is, not on the code, so the deadline only measured the machine
(the slowest health-plan input, four plans scanned at 10,001 points each, takes
about 26 ms on an idle laptop and was failed at 375 ms under load). Runtime is
bounded by ``max_examples`` instead; a calculator's speed, if it ever matters,
gets a test of its own rather than a per-example timer.
"""

from __future__ import annotations

import os

from hypothesis import settings

CI = "ci"
DEV = "dev"


def load() -> None:
    settings.register_profile(CI, settings.get_profile("ci"), deadline=None)
    settings.register_profile(DEV, settings.get_profile("default"), deadline=None)
    settings.load_profile(CI if os.environ.get("CI") else DEV)
