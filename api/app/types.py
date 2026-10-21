"""Field types shared by response models."""

from __future__ import annotations

import datetime as dt
from typing import Annotated

from pydantic import AfterValidator


def _to_utc(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return value.astimezone(dt.UTC)


# Postgres returns timestamptz in the session's TimeZone; the API always
# answers in UTC ("...Z") whatever that setting is.
UtcDateTime = Annotated[dt.datetime, AfterValidator(_to_utc)]
