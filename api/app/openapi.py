"""Export the OpenAPI document: ``python -m app.openapi > openapi.json`` (run from api/).

The committed ``api/openapi.json`` is the contract the web client's types are
generated from; CI fails when it drifts from the app.
"""

from __future__ import annotations

import json

from app.config import Settings
from app.main import create_app


def render_openapi() -> str:
    """The document as stable, pretty-printed JSON with a trailing newline."""
    # Settings from defaults only: the document must not depend on the environment.
    app = create_app(Settings(_env_file=None, git_sha="openapi"))
    return json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> None:
    print(render_openapi(), end="")


if __name__ == "__main__":
    main()
