"""The plan's files (spec 016).

``calendar`` (the ``.ics`` text, standard library only) and ``store`` (the
table of rendered PDFs) are API-safe. ``html`` (Jinja2) and ``pdf``
(WeasyPrint, which loads pango) run only in the worker: the API process never
imports them (``tests/unit/test_boundaries.py``).
"""
