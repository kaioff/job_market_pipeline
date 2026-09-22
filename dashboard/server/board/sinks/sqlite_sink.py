"""Primary durable sink: a single local SQLite file.

Databricks can't hold this role. Free Edition gates compute at its own
discretion — the workspace went INACTIVE for two days in Sept 2026 with no
warning — so a feed that depends on it for durability silently loses every
posting across a restart in that window.

SQLite has no daemon, no install (sqlite3 ships with Python), no network,
and native ON CONFLICT, which is a closer fit for this workload than a MERGE
against Delta. The board survives restarts whether or not Databricks is
awake.
"""

import os
import sqlite3
from pathlib import Path

from board.timeutil import iso_from_ms, now_ms

DB_PATH = os.getenv("BOARD_DB_PATH", "./data/board.sqlite")

COLUMNS = (
    "posting_id", "title", "company", "location", "job_url", "posted_at",
    "posted_at_precise", "applicants", "retrieved_at", "source",
)

_db: sqlite3.Connection | None = None


def _connect() -> sqlite3.Connection:
    global _db
    if _db is not None:
        return _db

    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    # The poller and request handlers share one event-loop thread, but the
    # connection is also touched from startup code; allow that explicitly.
    _db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
    _db.row_factory = sqlite3.Row

    # WAL so a long read (the boot seed) can't block the poller's write.
    _db.execute("PRAGMA journal_mode = WAL")
    _db.execute("PRAGMA synchronous = NORMAL")

    _db.execute(
        """
        CREATE TABLE IF NOT EXISTS postings (
          posting_id   TEXT PRIMARY KEY,
          title        TEXT,
          company      TEXT,
          location     TEXT,
          job_url      TEXT,
          posted_at    TEXT,
          -- Absolute time derived from the detail page's "40 minutes ago".
          -- The board shows this; posted_at is date-only and rounds to midnight.
          posted_at_precise TEXT,
          applicants   INTEGER,
          retrieved_at TEXT NOT NULL,
          source       TEXT
        )
        """
    )
    # The seed reads a window ordered by arrival; without this it's a full
    # scan plus a sort on every boot.
    _db.execute(
        "CREATE INDEX IF NOT EXISTS idx_postings_retrieved ON postings(retrieved_at DESC)"
    )
    return _db


def _cutoff(window_hours: float) -> str:
    return iso_from_ms(now_ms() - window_hours * 3600 * 1000)


class SqliteSink:
    name = "sqlite"
    primary = True

    async def persist(self, postings: list[dict]) -> None:
        conn = _connect()
        # One transaction per batch: 25 individual commits would each fsync.
        conn.execute("BEGIN")
        try:
            conn.executemany(
                f"""
                INSERT INTO postings ({", ".join(COLUMNS)})
                VALUES ({", ".join("?" for _ in COLUMNS)})
                ON CONFLICT(posting_id) DO NOTHING
                """,
                [tuple(p.get(c) for c in COLUMNS) for p in postings],
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    def recent(self, window_hours: float, limit: int) -> list[dict]:
        """Rehydrates the in-memory store at boot. Local, so no cold start."""
        rows = _connect().execute(
            f"""
            SELECT {", ".join(COLUMNS)}
            FROM postings
            WHERE retrieved_at >= ?
            ORDER BY retrieved_at DESC
            LIMIT ?
            """,
            (_cutoff(window_hours), limit),
        )
        return [dict(r) for r in rows]

    def prune(self, window_hours: float) -> None:
        """Drops rows that have aged out of the window.

        The board only ever shows the window, and Delta holds the long-term
        copy, so unbounded growth here would be pure waste.
        """
        _connect().execute("DELETE FROM postings WHERE retrieved_at < ?", (_cutoff(window_hours),))


sqlite_sink = SqliteSink()
