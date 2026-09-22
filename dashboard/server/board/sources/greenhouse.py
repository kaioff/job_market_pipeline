"""Greenhouse public job board API.

The reason to prefer this over LinkedIn: `first_published` is an exact ISO
timestamp set at publication, and the endpoint reflects it immediately — a
live probe found a Stripe posting 0.0 hours old. LinkedIn gives "3 hours
ago" on a page it only indexes some time after the fact, so this is both
more precise and genuinely earlier.

Public, documented, and meant to be consumed, so there's no rate-limit or
ToS exposure of the kind the LinkedIn adapter carries.
"""

import logging

from board.sources.companies import companies
from board.sources.http import client
from board.timeutil import iso_from_ms, now_ms, parse_ms

log = logging.getLogger("board")

API = "https://boards-api.greenhouse.io/v1/boards"


def _normalize(job: dict, slug: str) -> dict:
    published = job.get("first_published") or job.get("updated_at")
    published_ms = parse_ms(published)
    return {
        # Namespaced so IDs can't collide across ATSs or companies.
        "posting_id": f"gh:{slug}:{job['id']}",
        "title": job.get("title"),
        "company": job.get("company_name") or slug,
        "location": (job.get("location") or {}).get("name"),
        # Straight to the company's own application form — one hop fewer
        # than routing through LinkedIn.
        "job_url": job.get("absolute_url"),
        "posted_at": published[:10] if published else None,
        "posted_at_precise": iso_from_ms(published_ms) if published_ms is not None else None,
        "applicants": None,
    }


class GreenhouseSource:
    name = "greenhouse"

    async def fetch_recent(self, window_seconds: int) -> list[dict]:
        cutoff = now_ms() - window_seconds * 1000
        out = []
        for slug in companies("greenhouse"):
            try:
                res = await client.get(f"{API}/{slug}/jobs")
                if res.status_code != 200:
                    log.warning("[board] greenhouse/%s -> HTTP %d, skipped", slug, res.status_code)
                    continue
                for job in res.json().get("jobs", []):
                    p = _normalize(job, slug)
                    # The endpoint returns the entire board (hundreds of
                    # roles), so the window filter is what makes this a feed
                    # rather than a dump.
                    if not p["posted_at_precise"]:
                        continue
                    if parse_ms(p["posted_at_precise"]) < cutoff:
                        continue
                    out.append(p)
            except Exception as err:
                log.warning("[board] greenhouse/%s failed: %s", slug, err)
        return out

    # Timestamps arrive complete; nothing to enrich.
    async def enrich(self, posting: dict) -> dict:
        return posting

    @property
    def slice_count(self) -> int:
        return len(companies("greenhouse"))


greenhouse_source = GreenhouseSource()
