"""The hot store: in-process memory, not a database.

Why memory rather than reading back from a database — the poller is the only
writer, so it already knows what's new and never needs to query to find out.
Keeping reads in-process means no page load and no SSE event waits on I/O.

Durability lives in sinks/ (SQLite primary, Delta best-effort), and boot
rehydration reads from the local SQLite file, so nothing here depends on
Databricks being awake.

Cost of that choice: state dies with the process (hence seed()), and it
assumes a single server instance. Two instances would each hold their own
view and double-write. That's the point where this should become Redis —
not before.
"""

import asyncio
import json
import logging
import os

from board.sinks import load_recent, prune_all
from board.timeutil import now_iso, now_ms, parse_ms

log = logging.getLogger("board")


def _num(name: str, default: str) -> int | float:
    """Env number, kept as an int when whole so status JSON shows 48, not 48.0."""
    value = float(os.getenv(name, default))
    return int(value) if value.is_integer() else value


WINDOW_HOURS = _num("BOARD_WINDOW_HOURS", "48")

# Hard cap on how old a posting may be to appear on the board.
#
# Deliberately separate from the fetch window and from WINDOW_HOURS. The
# fetch window is generous on purpose — it's 3x the poll interval so a slow
# or failed poll can't miss anything — but "how far back do I look" and "how
# old may a posting be" are different questions. Conflating them meant a
# wide window leaked stale jobs onto a board whose entire purpose is
# applying early.
MAX_AGE_HOURS = _num("BOARD_MAX_AGE_HOURS", "24")
MAX_BUFFER = int(os.getenv("BOARD_MAX_BUFFER", "5000"))

# posting_id set, for O(1) "have I seen this?" without a query.
_seen_ids: set[str] = set()

# Newest-first list of postings inside the rolling window. Sorted by
# retrieved_at (when *we* found it), not posted_at — LinkedIn's posted_at is
# coarse ("2 days ago" rounds hard) and the board is about arrival.
_buffer: list[dict] = []

# One queue per connected SSE client; broadcast() drops frames into each.
_subscribers: set[asyncio.Queue] = set()


def _window_cutoff() -> float:
    return now_ms() - WINDOW_HOURS * 3600 * 1000


def _posted_at_ms(p: dict) -> float | None:
    """When the posting was published, best available.

    posted_at is date-only, so it reads as midnight — which makes a job look
    up to 24h older than it is. Only used when precise is missing.
    """
    return parse_ms(p.get("posted_at_precise") or p.get("posted_at") or p.get("retrieved_at"))


def _too_old(p: dict) -> bool:
    ms = _posted_at_ms(p)
    if ms is None:
        return False  # unknown age: keep rather than silently drop
    return ms < now_ms() - MAX_AGE_HOURS * 3600 * 1000


def _prune() -> None:
    global _buffer
    cutoff = _window_cutoff()
    # Two independent bounds: retrieval age keeps the buffer small, posting
    # age keeps the board fresh. A row leaves when it fails either.
    _buffer = [
        p for p in _buffer
        if (parse_ms(p["retrieved_at"]) or 0) >= cutoff and not _too_old(p)
    ][:MAX_BUFFER]


def has_seen(posting_id: str) -> bool:
    return posting_id in _seen_ids


def admit(postings: list[dict]) -> list[dict]:
    """Filters a fetched batch down to postings we've never seen, stamps them
    with retrieval time, and adds them to the buffer.

    This is where "new" is defined, and it's the whole reason the store has
    to exist: newness is a statement about history, so it needs memory.
    Returns only the genuinely-new postings, for the caller to persist and
    broadcast.
    """
    global _buffer
    retrieved_at = now_iso()
    fresh = []

    for p in postings:
        if p["posting_id"] in _seen_ids:
            continue
        # Mark it seen even when it's too old, so a stale posting isn't
        # re-evaluated (and re-enriched) on every single poll.
        _seen_ids.add(p["posting_id"])
        if _too_old(p):
            continue
        fresh.append({**p, "retrieved_at": retrieved_at})

    if fresh:
        _buffer = fresh + _buffer
        _prune()

    return fresh


def recent(limit: int = 200) -> list[dict]:
    """Newest-first postings inside the window, for GET /api/board/recent."""
    _prune()
    return _buffer[:limit]


def stats() -> dict:
    return {
        "buffered": len(_buffer),
        "seen_ids": len(_seen_ids),
        "window_hours": WINDOW_HOURS,
        "max_age_hours": MAX_AGE_HOURS,
        "newest": _buffer[0]["retrieved_at"] if _buffer else None,
    }


# ---------- SSE fan-out ----------


def subscribe() -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue()
    _subscribers.add(queue)
    return queue


def unsubscribe(queue: asyncio.Queue) -> None:
    _subscribers.discard(queue)


def broadcast(event: str, payload) -> None:
    frame = f"event: {event}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"
    for queue in _subscribers:
        queue.put_nowait(frame)


def subscriber_count() -> int:
    return len(_subscribers)


# ---------- Boot ----------


async def seed() -> None:
    """Rehydrate from the local SQLite file at startup, and drop rows that
    have aged out of the window.

    Reading from disk rather than Databricks is the whole point of the sink
    split: boot is fast, offline, and unaffected by warehouse availability.
    A failure is still non-fatal — an empty store just means the first poll
    looks like a burst of new postings.
    """
    global _buffer
    try:
        prune_all(WINDOW_HOURS)
        _buffer = load_recent(WINDOW_HOURS, MAX_BUFFER)
        for r in _buffer:
            _seen_ids.add(r["posting_id"])
        _buffer = [p for p in _buffer if not _too_old(p)]
        log.info("[board] seeded %d postings from sqlite (max age %gh)", len(_buffer), MAX_AGE_HOURS)
    except Exception as err:
        log.warning(
            "[board] seed failed (%s) — starting cold. "
            "First poll will look like a burst of new postings.",
            err,
        )
