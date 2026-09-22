"""SmartRecruiters public postings API.

`releasedDate` is a full ISO timestamp, so this sits alongside Greenhouse and
Ashby in the top freshness tier.
"""

import logging

from board.sources.companies import companies
from board.sources.http import client
from board.timeutil import iso_from_ms, now_ms, parse_ms

log = logging.getLogger("board")

API = "https://api.smartrecruiters.com/v1/companies"


def _normalize(job: dict, slug: str) -> dict:
    published = job.get("releasedDate")
    published_ms = parse_ms(published)
    location = job.get("location") or {}
    return {
        "posting_id": f"sr:{slug}:{job['id']}",
        "title": job.get("name"),
        "company": (job.get("company") or {}).get("name") or slug,
        "location": location.get("fullLocation") or location.get("city"),
        "job_url": f"https://jobs.smartrecruiters.com/{slug}/{job['id']}",
        "posted_at": published[:10] if published else None,
        "posted_at_precise": iso_from_ms(published_ms) if published_ms is not None else None,
        "applicants": None,
    }


class SmartRecruitersSource:
    name = "smartrecruiters"

    async def fetch_recent(self, window_seconds: int) -> list[dict]:
        cutoff = now_ms() - window_seconds * 1000
        out = []
        for slug in companies("smartrecruiters"):
            try:
                res = await client.get(f"{API}/{slug}/postings")
                if res.status_code != 200:
                    log.warning("[board] smartrecruiters/%s -> HTTP %d, skipped", slug, res.status_code)
                    continue
                for job in res.json().get("content", []):
                    p = _normalize(job, slug)
                    if not p["posted_at_precise"]:
                        continue
                    if parse_ms(p["posted_at_precise"]) < cutoff:
                        continue
                    out.append(p)
            except Exception as err:
                log.warning("[board] smartrecruiters/%s failed: %s", slug, err)
        return out

    async def enrich(self, posting: dict) -> dict:
        return posting

    @property
    def slice_count(self) -> int:
        return len(companies("smartrecruiters"))


smartrecruiters_source = SmartRecruitersSource()
