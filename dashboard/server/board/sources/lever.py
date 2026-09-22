"""Lever public postings API.

`createdAt` is epoch milliseconds rather than ISO — the only shape
difference worth noting across the ATSs.
"""

import logging

from board.sources.companies import companies
from board.sources.http import client
from board.timeutil import iso_from_ms, now_ms, parse_ms

log = logging.getLogger("board")

API = "https://api.lever.co/v0/postings"


def _normalize(job: dict, slug: str) -> dict:
    published = iso_from_ms(job["createdAt"]) if job.get("createdAt") else None
    return {
        "posting_id": f"lever:{slug}:{job['id']}",
        "title": job.get("text"),
        "company": slug,
        "location": (job.get("categories") or {}).get("location"),
        "job_url": job.get("applyUrl") or job.get("hostedUrl"),
        "posted_at": published[:10] if published else None,
        "posted_at_precise": published,
        "applicants": None,
    }


class LeverSource:
    name = "lever"

    async def fetch_recent(self, window_seconds: int) -> list[dict]:
        cutoff = now_ms() - window_seconds * 1000
        out = []
        for slug in companies("lever"):
            try:
                res = await client.get(f"{API}/{slug}?mode=json")
                if res.status_code != 200:
                    log.warning("[board] lever/%s -> HTTP %d, skipped", slug, res.status_code)
                    continue
                jobs = res.json()
                for job in jobs if isinstance(jobs, list) else []:
                    p = _normalize(job, slug)
                    if not p["posted_at_precise"]:
                        continue
                    if parse_ms(p["posted_at_precise"]) < cutoff:
                        continue
                    out.append(p)
            except Exception as err:
                log.warning("[board] lever/%s failed: %s", slug, err)
        return out

    async def enrich(self, posting: dict) -> dict:
        return posting

    @property
    def slice_count(self) -> int:
        return len(companies("lever"))


lever_source = LeverSource()
