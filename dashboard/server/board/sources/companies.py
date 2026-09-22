"""Which company boards to poll, per ATS.

Derived, not curated. The list comes from resolver.py — every company seen
in LinkedIn search results that we managed to map onto a supported ATS.
That's what keeps this from being a hand-maintained target list: discovery
stays broad (LinkedIn sees every employer), while delivery stays fast (ATS
boards publish instantly).

Env vars still win, for pinning a company the resolver can't find or for
running a fixed set in a test.
"""

import os

from board.sources.resolver import resolved_boards

ENV = {
    "greenhouse": "BOARD_GREENHOUSE",
    "ashby": "BOARD_ASHBY",
    "lever": "BOARD_LEVER",
    "smartrecruiters": "BOARD_SMARTRECRUITERS",
    "workable": "BOARD_WORKABLE",
}


def _from_env(ats: str) -> list[str]:
    raw = os.getenv(ENV[ats], "")
    return [s.strip() for s in raw.split(",") if s.strip()]


def companies(ats: str) -> list[str]:
    """Env-pinned boards plus resolved ones, deduped, in that order.

    Read through to the resolver on every call rather than snapshotting at
    import time — the map grows while the process runs, as discovery finds
    companies, and a newly resolved board should join the next poll without
    a restart.
    """
    return list(dict.fromkeys(_from_env(ats) + resolved_boards().get(ats, [])))
