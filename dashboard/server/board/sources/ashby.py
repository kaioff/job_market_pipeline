"""Ashby public job board API. Same bargain as Greenhouse: exact
`publishedAt`, a direct `applyUrl`, no auth, no ban risk.
"""

import logging

from board.sources.companies import companies
from board.sources.http import client
from board.timeutil import iso_from_ms, now_ms, parse_ms

log = logging.getLogger("board")

API = "https://api.ashbyhq.com/posting-api/job-board"


def _normalize(job: dict, slug: str) -> dict:
    published = job.get("publishedAt")
    published_ms = parse_ms(published)
    return {
        "posting_id": f"ashby:{slug}:{job['id']}",
        "title": job.get("title"),
        "company": slug,
        "location": job.get("location") or None,
        # applyUrl lands on the form itself; jobUrl is the description page.
        "job_url": job.get("applyUrl") or job.get("jobUrl"),
        "posted_at": published[:10] if published else None,
        "posted_at_precise": iso_from_ms(published_ms) if published_ms is not None else None,
        "applicants": None,
    }


class AshbySource:
    name = "ashby"

    async def fetch_recent(self, window_seconds: int) -> list[dict]:
        cutoff = now_ms() - window_seconds * 1000
        out = []
        for slug in companies("ashby"):
            try:
                res = await client.get(f"{API}/{slug}")
                if res.status_code != 200:
                    log.warning("[board] ashby/%s -> HTTP %d, skipped", slug, res.status_code)
                    continue
                for job in res.json().get("jobs", []):
                    # isListed false means pulled from the public board.
                    if job.get("isListed") is False:
                        continue
                    p = _normalize(job, slug)
                    if not p["posted_at_precise"]:
                        continue
                    if parse_ms(p["posted_at_precise"]) < cutoff:
                        continue
                    out.append(p)
            except Exception as err:
                log.warning("[board] ashby/%s failed: %s", slug, err)
        return out

    async def enrich(self, posting: dict) -> dict:
        return posting

    @property
    def slice_count(self) -> int:
        return len(companies("ashby"))


ashby_source = AshbySource()
