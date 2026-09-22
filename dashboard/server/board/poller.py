"""The loop that makes the board live.

Deliberately a plain background task in the API process, not a streaming
cluster or a scheduled job: at one or two slices this is ~12 requests an
hour, and the whole point of the design is that nothing has to run 24/7
beyond the server that was already running.
"""

import asyncio
import logging
import os

from board.filter import active_titles, filter_by_title
from board.sinks import persist_all
from board.sources import active_sources, enrich, fetch_all
from board.store import admit, broadcast, has_seen, seed, stats
from board.timeutil import now_iso

log = logging.getLogger("board")

INTERVAL_SECONDS = float(os.getenv("BOARD_POLL_SECONDS", "300"))

# How far back each poll looks.
#
# At least 3x the poll interval, so a slow or failed poll can't punch a hole
# in coverage — but never less than the board's display age, or a fresh
# start could never fill: the store would happily show 24h of postings while
# the fetch only ever asked for the last 15 minutes.
#
# Widening this is close to free. The ATS endpoints return an entire board
# on every request no matter what, so the window is a client-side filter
# over a response we already paid for; only LinkedIn's f_TPR changes the
# request at all, and it's still one call. Re-seeing a posting costs nothing
# either — the store drops it on posting_id.
MAX_AGE_SECONDS = float(os.getenv("BOARD_MAX_AGE_HOURS", "24")) * 3600
WINDOW_SECONDS = int(max(round(INTERVAL_SECONDS * 3), MAX_AGE_SECONDS))

# A block from LinkedIn is silent: you keep getting HTTP 200 with an empty
# result set, which is indistinguishable from a quiet market. Without this
# alarm a dead feed looks exactly like a slow hiring week, for days.
EMPTY_ALARM_THRESHOLD = int(os.getenv("BOARD_EMPTY_ALARM", "12"))

# Key names match what /api/board/status has always returned.
state = {
    "running": False,
    "lastPollAt": None,
    "lastError": None,
    "consecutiveEmpty": 0,
    "pollCount": 0,
    "consecutiveFailures": 0,
    "suspectBlocked": False,
    "totalAdmitted": 0,
}

_task: asyncio.Task | None = None


def _backoff_seconds() -> float:
    # Exponential, capped at 30min. Applied on transport errors and 429s.
    return min(INTERVAL_SECONDS * 2 ** state["consecutiveFailures"], 30 * 60)


async def _poll_once() -> None:
    all_postings = await fetch_all(WINDOW_SECONDS)

    # Keyword search matches description text, so most of what comes back
    # isn't the role. Filter before anything else — it's what keeps the
    # enrichment request count (and the ban risk) low.
    found = filter_by_title(all_postings)

    # Enrich only postings we haven't seen, so any extra request happens
    # once per posting rather than once per poll. ATS sources are already
    # complete and no-op here; only LinkedIn actually fetches.
    candidates = [p for p in found if not has_seen(p["posting_id"])]
    enriched = []
    for p in candidates:
        enriched.append(await enrich(p))
        if p.get("source") == "linkedin-guest" and len(candidates) > 1:
            await asyncio.sleep(0.8)

    fresh = admit(enriched)

    state["lastPollAt"] = now_iso()
    state["consecutiveFailures"] = 0
    state["lastError"] = None

    if not all_postings:
        state["consecutiveEmpty"] += 1
        if state["consecutiveEmpty"] >= EMPTY_ALARM_THRESHOLD and not state["suspectBlocked"]:
            state["suspectBlocked"] = True
            log.error(
                "[board] %d consecutive empty polls — likely rate-limited or blocked, "
                "NOT a quiet market. Check egress IP; datacenter ranges get blocked fastest.",
                state["consecutiveEmpty"],
            )
    else:
        state["consecutiveEmpty"] = 0
        state["suspectBlocked"] = False

    # The first poll after boot backfills everything already inside the
    # window, so it is not a burst of new jobs — it's the board catching up.
    # Flagged so notifications can stay quiet for it; without this you'd get
    # pinged about 24h of postings every time the process restarts.
    #
    # This has to be computed and incremented BEFORE the empty-batch early
    # return below, or a poll that happens to find nothing new (the common
    # case once the board is warm) never advances pollCount — every
    # subsequent poll would then be misclassified as the first, forever.
    is_backfill = state["pollCount"] == 0
    state["pollCount"] += 1

    if not fresh:
        return

    state["totalAdmitted"] += len(fresh)

    broadcast("postings", [{**p, "backfill": is_backfill} for p in fresh])

    try:
        await persist_all(fresh)
    except Exception as err:
        # Only a primary-sink failure reaches here; secondary sinks log and
        # continue inside persist_all. Still non-fatal: the postings are live
        # in memory and on screen, and losing durability for one batch beats
        # crashing the feed.
        log.error("[board] persist failed: %s", err)

    log.info(
        "[board] %s%d new (%d matched title of %d in window)",
        "backfill " if is_backfill else "+", len(fresh), len(found), len(all_postings),
    )


async def _loop() -> None:
    while True:
        delay = INTERVAL_SECONDS
        try:
            await _poll_once()
        except Exception as err:
            state["consecutiveFailures"] += 1
            state["lastError"] = str(err)
            delay = _backoff_seconds()
            log.error("[board] poll failed (%s) — retrying in %ds", err, round(delay))
        await asyncio.sleep(delay)


async def start_poller() -> None:
    global _task
    if state["running"]:
        return
    state["running"] = True

    await seed()

    log.info(
        "[board] polling %s every %gs over a %ds window",
        ", ".join(active_sources()), INTERVAL_SECONDS, WINDOW_SECONDS,
    )
    log.info("[board] title filter: %s", " | ".join(active_titles))

    _task = asyncio.create_task(_loop())


async def stop_poller() -> None:
    if _task:
        _task.cancel()


def poller_status() -> dict:
    return {"sources": active_sources(), **state, **stats()}
