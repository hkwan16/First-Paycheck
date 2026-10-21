"""Process-wide logging setup for the API, worker and CLI entrypoints."""

from __future__ import annotations

import logging

from app.config import get_settings


def configure_logging() -> None:
    logging.basicConfig(
        level=get_settings().log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
