"""The plan's files (spec 016).

``calendar`` (the ``.ics`` text, standard library only) and ``store`` (the
``plan_exports`` table) are API-safe. ``html`` (Jinja2) and ``pdf``
(WeasyPrint, which loads pango) run only in the worker: the API process never
imports them (``tests/unit/test_boundaries.py``).
"""
