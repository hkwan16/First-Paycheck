"""Load reference data: ``python -m db.seed.load``.

Runs on every deploy after ``alembic upgrade head`` (Render pre-deploy), so
every loader must be idempotent. Seeds (category rules, IRS citations) arrive
with their tables; until then this is a logged no-op.
"""

from __future__ import annotations

import logging

from app.logs import configure_logging

logger = logging.getLogger("db.seed")


def load() -> int:
    logger.info("no seeds yet")
    return 0


def main() -> int:
    configure_logging()
    return load()


if __name__ == "__main__":
    raise SystemExit(main())
