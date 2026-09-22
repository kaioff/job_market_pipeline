"""Timestamps in one format everywhere.

Everything is stored and compared as ISO-8601 UTC strings with millisecond
precision ("2026-09-22T00:09:01.312Z") — the format the JavaScript server
wrote, so rows already in SQLite keep sorting and comparing correctly as
plain text.
"""

import time
from datetime import datetime, timezone


def to_iso(dt: datetime) -> str:
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso() -> str:
    return to_iso(datetime.now(timezone.utc))


def iso_from_ms(ms: float) -> str:
    return to_iso(datetime.fromtimestamp(ms / 1000, timezone.utc))


def now_ms() -> float:
    return time.time() * 1000


def parse_ms(value) -> float | None:
    """Epoch milliseconds from an ISO date or timestamp, or None if unparseable.

    Date-only and zone-less values are read as UTC, matching how
    JavaScript's Date.parse treated them.
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() * 1000
