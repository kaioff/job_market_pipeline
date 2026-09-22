"""Fan-out to durable sinks, in priority order.

The distinction that matters is `primary`. A primary sink failing is a real
problem and propagates; a secondary one failing is logged and ignored, so a
dead SQL Warehouse can never take down the feed.
"""

import logging
import os

from board.sinks.delta_sink import delta_sink
from board.sinks.sqlite_sink import sqlite_sink

log = logging.getLogger("board")

DELTA_ENABLED = os.getenv("BOARD_DELTA_SINK") != "false"

SINKS = [sqlite_sink, *([delta_sink] if DELTA_ENABLED else [])]


async def persist_all(postings: list[dict]) -> None:
    if not postings:
        return
    for sink in SINKS:
        try:
            await sink.persist(postings)
        except Exception as err:
            if sink.primary:
                raise
            log.warning(
                '[board] secondary sink "%s" failed: %s — postings are still durable in %s',
                sink.name, err, sqlite_sink.name,
            )


def load_recent(window_hours: float, limit: int) -> list[dict]:
    """Boot rehydration, always from the primary. Local file, no cold start."""
    return sqlite_sink.recent(window_hours, limit)


def prune_all(window_hours: float) -> None:
    sqlite_sink.prune(window_hours)
