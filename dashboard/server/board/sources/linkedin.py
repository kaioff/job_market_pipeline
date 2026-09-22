"""Source adapter for LinkedIn's public guest job-search endpoint.

Every source adapter has the same shape — `name` and an async
`fetch_recent(window_seconds)` returning normalized postings — so the poller
never knows which upstream it's talking to. Swapping in an ATS board or a
paid webhook feed means adding a sibling file, not touching the poller, the
store, or the page.
"""

import os
import re
from urllib.parse import quote

from bs4 import BeautifulSoup

from board.sources.http import client
from board.timeutil import iso_from_ms, now_ms

SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
DETAIL_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting"


def _parse_slices() -> list[dict]:
    """Slices to watch, as "keywords|location" pairs.

    Kept deliberately small: request volume is the only real ban risk, and
    it scales with this list.
    """
    out = []
    for s in os.getenv("BOARD_SLICES", "data engineer|San Francisco Bay Area").split(","):
        if not s.strip():
            continue
        keywords, _, location = (p.strip() for p in s.partition("|"))
        out.append({"keywords": keywords, "location": location or "United States"})
    return out


SLICES = _parse_slices()

# A browser-ish UA. The guest endpoint serves empty results to obviously
# scripted clients, and an empty 200 is indistinguishable from "no new jobs"
# — see the consecutive-empty alarm in poller.py.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


class RateLimitedError(Exception):
    """LinkedIn answered 429; the poller backs off instead of treating it as empty."""


def _text(el) -> str:
    return re.sub(r"\s+", " ", el.get_text()).strip() if el else ""


def _extract_posting_id(card) -> str | None:
    """Pull the stable numeric posting ID off a card.

    This is the single most important function in the file. The card's href
    carries per-request tracking params (refId, trackingId) that differ on
    every fetch, so the same job yields a different URL each poll. Keying
    dedup on the URL would make every posting look new forever and flood the
    feed. The ID is stable; that's what we key on, and what we rebuild a
    clean apply link from.

    Prefer data-entity-urn ("urn:li:jobPosting:4464656181") over parsing the
    href — it's an explicit ID field rather than a slug we'd be reverse
    engineering, so it survives title/company changes in the URL text.
    """
    urn = card.get("data-entity-urn") or ""
    m = re.search(r"jobPosting:(\d+)", urn)
    if m:
        return m.group(1)
    link = card.select_one("a.base-card__full-link")
    m = re.search(r"-(\d{6,})(?:\?|$)", (link.get("href") if link else "") or "")
    return m.group(1) if m else None


def _parse_cards(html: str) -> list[dict]:
    out = []
    for card in BeautifulSoup(html, "html.parser").select("div.base-search-card"):
        posting_id = _extract_posting_id(card)
        if not posting_id:
            continue
        title = _text(card.select_one("h3.base-search-card__title"))
        if not title:
            continue
        time_el = card.select_one("time")
        out.append({
            "posting_id": posting_id,
            "title": title,
            "company": _text(card.select_one("h4.base-search-card__subtitle")) or None,
            "location": _text(card.select_one(".job-search-card__location")) or None,
            # Canonical apply link, tracking params stripped. This is what
            # the board links to — clicking it goes straight to the
            # application.
            "job_url": f"https://www.linkedin.com/jobs/view/{posting_id}/",
            # LinkedIn's own posted date (YYYY-MM-DD). Coarse, which is why
            # the board sorts on retrieved_at instead.
            "posted_at": (time_el.get("datetime") if time_el else None) or None,
        })
    return out


UNIT_MS = {"minute": 6e4, "hour": 36e5, "day": 864e5, "week": 6048e5, "month": 2592e6}


def parse_relative_age(txt: str | None, now: float | None = None) -> str | None:
    """Turn LinkedIn's relative posting age ("40 minutes ago", "22 hours ago")
    into an absolute timestamp.

    Coarse by construction — "22 hours ago" could be anywhere in a 30-minute
    band — but far better than the search card's `datetime` attribute, which
    is date-only and rounds a 40-minute-old job to midnight.
    """
    if not txt:
        return None
    m = re.search(r"(\d+)\s+(minute|hour|day|week|month)s?\s+ago", txt.strip().lower())
    if not m:
        return None
    return iso_from_ms((now or now_ms()) - int(m.group(1)) * UNIT_MS[m.group(2)])


async def _fetch_detail(posting_id: str) -> dict:
    """Second request, for postings we've decided to keep.

    Deliberately not run over every search result — only over new postings
    that already passed the title filter, which is a handful per poll. That
    keeps the added request volume small, which is the only thing standing
    between this and a rate limit.
    """
    res = await client.get(f"{DETAIL_URL}/{posting_id}", headers=HEADERS)
    if res.status_code != 200:
        return {}
    soup = BeautifulSoup(res.text, "html.parser")
    ago_text = _text(soup.select_one(".posted-time-ago__text"))
    applicants = re.search(r"(\d+)", _text(soup.select_one(".num-applicants__caption")))
    return {
        "posted_at_precise": parse_relative_age(ago_text),
        "posted_age_text": ago_text or None,
        "applicants": int(applicants.group(1)) if applicants else None,
    }


async def _fetch_slice(slice_: dict, window_seconds: int) -> list[dict]:
    url = (
        f"{SEARCH_URL}?keywords={quote(slice_['keywords'])}"
        f"&location={quote(slice_['location'])}"
        f"&f_TPR=r{window_seconds}&start=0"
    )
    res = await client.get(url, headers=HEADERS)
    # 429 is an explicit rate-limit; surface it so the poller can back off
    # rather than treating it as an empty result.
    if res.status_code == 429:
        raise RateLimitedError("LinkedIn rate-limited the request (429)")
    if res.status_code != 200:
        raise RuntimeError(f"LinkedIn returned HTTP {res.status_code}")
    return _parse_cards(res.text)


class LinkedInSource:
    name = "linkedin-guest"
    slice_count = len(SLICES)

    async def fetch_recent(self, window_seconds: int) -> list[dict]:
        """Every posting visible in the last `window_seconds`, across all
        configured slices, deduped within the batch. Newness across polls is
        the store's job, not ours — this always returns the full window.
        """
        seen = set()
        out = []
        for slice_ in SLICES:
            for card in await _fetch_slice(slice_, window_seconds):
                if card["posting_id"] in seen:
                    continue
                seen.add(card["posting_id"])
                out.append(card)
        return out

    async def enrich(self, posting: dict) -> dict:
        """Enrich one posting with detail-page fields. Failures are
        swallowed: a missing posted time degrades the row to its search-card
        date, which is worse but not broken.
        """
        try:
            return {**posting, **(await _fetch_detail(posting["posting_id"]))}
        except Exception:
            return posting


linkedin_source = LinkedInSource()
