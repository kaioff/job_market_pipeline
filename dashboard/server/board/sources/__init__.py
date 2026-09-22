"""Multi-source aggregation.

ATS boards first, LinkedIn last — and LinkedIn off by default. The point of
going upstream is that Greenhouse/Ashby/Lever publish the moment a job goes
live, with an exact timestamp, while LinkedIn ingests from them and shows it
later. Polling the source is how you're early; polling LinkedIn is how you
compete with everyone else watching LinkedIn.

LinkedIn stays available (BOARD_LINKEDIN=true) for coverage of employers who
post nowhere else, at the cost of ToS exposure and ban risk the ATS adapters
don't carry.
"""

import asyncio
import logging
import os

from board.sources.ashby import ashby_source
from board.sources.greenhouse import greenhouse_source
from board.sources.lever import lever_source
from board.sources.linkedin import linkedin_source
from board.sources.smartrecruiters import smartrecruiters_source
from board.sources.workable import workable_source

log = logging.getLogger("board")

ALL = [
    greenhouse_source,
    ashby_source,
    lever_source,
    smartrecruiters_source,
    workable_source,
    *([linkedin_source] if os.getenv("BOARD_LINKEDIN") == "true" else []),
]

BY_NAME = {s.name: s for s in ALL}


def _enabled():
    # Re-evaluated per poll: the resolver map grows as discovery runs, so a
    # source with zero companies now may have some by the next tick.
    return [s for s in ALL if s.slice_count > 0]


async def fetch_all(window_seconds: int) -> list[dict]:
    """Fetches every source concurrently.

    Sources are independent HTTP calls to unrelated hosts, so there's nothing
    to gain from serializing them — and one slow board shouldn't hold up the
    rest.
    """
    sources = _enabled()
    results = await asyncio.gather(
        *(s.fetch_recent(window_seconds) for s in sources), return_exceptions=True
    )

    out = []
    seen = set()
    for source, result in zip(sources, results):
        if isinstance(result, BaseException):
            log.warning("[board] source %s failed: %s", source.name, result)
            continue
        for p in result:
            # posting_id is namespaced per source, so this only guards
            # against a board listing the same role twice.
            if p["posting_id"] in seen:
                continue
            seen.add(p["posting_id"])
            out.append({**p, "source": source.name})
    return out


async def enrich(posting: dict) -> dict:
    """Dispatches enrichment to the source that produced the posting."""
    source = BY_NAME.get(posting.get("source"))
    return await source.enrich(posting) if source else posting


def active_sources() -> list[str]:
    return [f"{s.name}({s.slice_count})" for s in _enabled()]
