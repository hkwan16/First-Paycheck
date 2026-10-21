"""Document ingestion (spec 004).

``store`` and ``chunk`` are safe in the API process. ``reader``, ``ocr``,
``redact`` and ``pipeline`` parse, rasterize and OCR files and run only in the
worker; ``tests/unit/test_boundaries.py`` keeps routers from importing them.
"""
