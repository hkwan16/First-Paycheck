# WeasyPrint ships no type information (no py.typed); its one call here is typed below.
# mypy: disable-error-code="import-untyped"
"""HTML to PDF with WeasyPrint (spec 016 rule 13). Worker only.

WeasyPrint loads pango, harfbuzz and fontconfig through cffi when it is
imported, so the import happens inside ``render_pdf``: importing this module
costs nothing, and the API process never calls it. The Docker image installs
the libraries and ``fonts-dejavu-core``, the template's first font.
"""

from __future__ import annotations

from typing import Any, NoReturn

__all__ = ["render_pdf"]


class ExternalResourceRefused(Exception):
    """The page asked for a URL; the plan PDF is built from its own HTML only."""


def _refuse(url: str, *args: Any, **kwargs: Any) -> NoReturn:
    raise ExternalResourceRefused(f"the plan PDF fetches nothing: {url}")


def render_pdf(html: str) -> bytes:
    """The PDF for a complete, self-contained HTML document.

    The URL fetcher refuses every request, so text that came from a user (a
    plan name) can never make the worker fetch anything.
    """
    from weasyprint import HTML

    pdf: bytes = HTML(string=html, url_fetcher=_refuse).write_pdf()
    return pdf
